/**
 * xyc 中转站 · 1h 提示词缓存注入代理（Deno Deploy Playground 单文件版）
 *
 * 上游：https://apicdn.xycai.us  （地址不带 /v1，客户端路径原样转发）
 *
 * 用法：新建一个 Playground，把这个文件整体粘贴进去，保存即部署。
 * LobeHub 的 Anthropic Base URL 填 https://你的项目名.deno.dev （后面不要再加 /v1）
 *
 * 可选环境变量（Playground 的 Settings 里加，不设也能跑）：
 *   UPSTREAM_URL      覆盖上游地址
 *   PROXY_TOKEN       访问令牌。设了之后请求必须带 x-proxy-token
 *   CACHE_TTL_ON      设为 "0" 临时关闭注入，便于 A/B 对比成本
 *   TAIL_BREAKPOINTS  会话尾部断点数，默认 2
 *   MIN_CACHE_TOKENS  建缓存的最小前缀 token 数，默认 1200；Haiku 档要设 2048
 *   DEBUG             设为 "1" 打印每次请求的断点落点
 */

// ==================== 只有这一段与 passion8 版本不同 ====================

const PROVIDER = "xyc";
const DEFAULT_UPSTREAM = "https://apicdn.xycai.us";
/** 上游地址是否已经包含 /v1 前缀。xyc 不含，所以是 false。 */
const UPSTREAM_HAS_V1 = false;

// ======================================================================

const TTL = "1h";

/** Anthropic 单请求最多 4 个 cache 断点。 */
const MAX_BREAKPOINTS = 4;

/**
 * 低于这个 token 数就不插断点：Anthropic 对小于最小 token 数的前缀直接拒绝缓存，
 * 白占一个断点额度。多数模型下限 1024，Haiku 档是 2048，
 * 这里留一点余量，可用 MIN_CACHE_TOKENS 覆盖（Haiku 建议设 2048）。
 */
const MIN_TOKENS = Number(Deno.env.get("MIN_CACHE_TOKENS") ?? "1200");

/** 1h TTL 必须声明的 beta 特性名。 */
const BETA_FLAG = "extended-cache-ttl-2025-04-11";

/** 接受 cache_control 的块类型；thinking 块不接受。 */
const CACHEABLE_TYPES = new Set([
  "text",
  "image",
  "document",
  "tool_use",
  "tool_result",
  "search_result",
]);

// deno-lint-ignore no-explicit-any
type Any = any;

function isObj(v: unknown): v is Record<string, Any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function cc() {
  return { type: "ephemeral", ttl: TTL };
}

/**
 * 粗略估算任意结构折算的 token 数。
 * CJK 按 1 字符≈1 token，其余按 4 字符≈1 token，偏保守。
 */
function tokensOf(v: unknown): number {
  let n = 0;
  const count = (s: string) => {
    let cjk = 0;
    for (const ch of s) {
      const c = ch.codePointAt(0)!;
      if (
        (c >= 0x3040 && c <= 0x30ff) ||
        (c >= 0x3400 && c <= 0x4dbf) ||
        (c >= 0x4e00 && c <= 0x9fff) ||
        (c >= 0xf900 && c <= 0xfaff) ||
        (c >= 0xac00 && c <= 0xd7af) ||
        (c >= 0x20000 && c <= 0x2ebef)
      ) {
        cjk++;
      }
    }
    const rest = s.length - cjk;
    n += cjk + Math.ceil(rest / 4);
  };
  const walk = (x: unknown) => {
    if (typeof x === "string") {
      count(x);
    } else if (Array.isArray(x)) {
      for (const y of x) walk(y);
    } else if (isObj(x)) {
      for (const y of Object.values(x)) walk(y);
    }
  };
  walk(v);
  return n;
}

/** 粗略估算可缓存内容总体量（token）。 */
function approxTokens(body: Any): number {
  return tokensOf(body?.tools) + tokensOf(body?.system) + tokensOf(body?.messages);
}

/** 收集已存在的 cache_control 宿主对象。 */
function existingHolders(body: Any): Record<string, Any>[] {
  const out: Record<string, Any>[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (!isObj(v)) return;
    if (isObj(v.cache_control)) out.push(v);
    for (const x of Object.values(v)) walk(x);
  };
  walk(body?.system);
  walk(body?.messages);
  walk(body?.tools);
  return out;
}

/** 字符串内容规范成块数组，便于挂断点。 */
function toBlocks(v: unknown): Record<string, Any>[] | null {
  if (typeof v === "string") {
    return v.trim() === "" ? null : [{ type: "text", text: v }];
  }
  if (Array.isArray(v)) {
    const blocks = v.filter(isObj);
    return blocks.length > 0 ? blocks : null;
  }
  return null;
}

function lastCacheable(blocks: Record<string, Any>[]): Record<string, Any> | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const t = blocks[i].type;
    if (typeof t === "string" && CACHEABLE_TYPES.has(t)) return blocks[i];
  }
  return null;
}

interface InjectResult {
  changed: boolean;
  /** 断点落点说明，用于日志。 */
  applied: string[];
  skipped?: string;
}

/**
 * 原地注入 Anthropic /v1/messages 断点。
 * 顺序按前缀稳定度：tools -> system -> 会话尾部。
 */
function injectAnthropic(body: Any, tailBreakpoints = 2): InjectResult {
  const applied: string[] = [];
  let changed = false;

  // 客户端已带的断点：改写成 1h，而不是另开一个断点浪费额度。
  const holders = existingHolders(body);
  for (const h of holders) {
    if (h.cache_control.ttl !== TTL) {
      h.cache_control = { ...h.cache_control, type: "ephemeral", ttl: TTL };
      changed = true;
    }
  }
  if (holders.length > 0) applied.push(`upgraded:${holders.length}`);

  const total = approxTokens(body);
  if (total < MIN_TOKENS) {
    return { changed, applied, skipped: `too-small:${total}<${MIN_TOKENS}tok` };
  }

  let budget = MAX_BREAKPOINTS - holders.length;
  if (budget <= 0) return { changed, applied, skipped: "no-budget" };

  const mark = (h: Record<string, Any>, label: string) => {
    h.cache_control = cc();
    applied.push(label);
    budget--;
    changed = true;
  };

  // 缓存前缀长度按“断点之前的累计内容”算，而不是整个请求体。
  // 断点之后的内容再长也不算进这个前缀，短前缀会被上游直接拒绝缓存。
  const toolsTokens = tokensOf(body.tools);
  const systemTokens = tokensOf(body.system);

  if (budget > 0 && Array.isArray(body.tools) && body.tools.length > 0) {
    const last = body.tools.filter(isObj).at(-1);
    if (last && !isObj(last.cache_control)) {
      if (toolsTokens >= MIN_TOKENS) mark(last, "tools");
      else applied.push(`skip-tools:${toolsTokens}tok`);
    }
  }

  if (budget > 0 && body.system !== undefined) {
    const blocks = toBlocks(body.system);
    const target = blocks && lastCacheable(blocks);
    if (blocks && target && !isObj(target.cache_control)) {
      const prefix = toolsTokens + systemTokens;
      if (prefix >= MIN_TOKENS) {
        body.system = blocks;
        mark(target, "system");
      } else {
        applied.push(`skip-system:${prefix}tok`);
      }
    }
  }

  if (budget > 0 && tailBreakpoints > 0 && Array.isArray(body.messages)) {
    // 每条消息之前的累计前缀长度，用于判断该断点是否够长。
    const prefixAt: number[] = [];
    let acc = toolsTokens + systemTokens;
    for (const msg of body.messages) {
      acc += tokensOf(msg);
      prefixAt.push(acc);
    }

    let placed = 0;
    for (
      let i = body.messages.length - 1;
      i >= 0 && placed < tailBreakpoints && budget > 0;
      i--
    ) {
      const msg = body.messages[i];
      if (!isObj(msg)) continue;
      if (prefixAt[i] < MIN_TOKENS) break;
      const blocks = toBlocks(msg.content);
      const target = blocks && lastCacheable(blocks);
      if (!blocks || !target || isObj(target.cache_control)) continue;
      msg.content = blocks;
      mark(target, `msg[${i}]:${msg.role ?? "?"}`);
      placed++;
    }
  }

  return { changed, applied };
}

/**
 * OpenAI 兼容通道（/v1/chat/completions）。
 * 中转站对该路径的 cache_control 支持不一致，这里只做保守处理：
 * 给 system 消息挂断点，并补齐已有断点的 ttl。
 */
function injectOpenAI(body: Any): InjectResult {
  const applied: string[] = [];
  let changed = false;

  const holders = existingHolders(body);
  for (const h of holders) {
    if (h.cache_control.ttl !== TTL) {
      h.cache_control = { ...h.cache_control, type: "ephemeral", ttl: TTL };
      changed = true;
    }
  }
  if (holders.length > 0) applied.push(`upgraded:${holders.length}`);

  const total = approxTokens(body);
  if (total < MIN_TOKENS) {
    return { changed, applied, skipped: `too-small:${total}<${MIN_TOKENS}tok` };
  }
  if (!Array.isArray(body.messages)) return { changed, applied, skipped: "no-messages" };

  for (const msg of body.messages) {
    if (!isObj(msg) || msg.role !== "system") continue;
    if (Array.isArray(msg.content)) {
      const target = lastCacheable(msg.content.filter(isObj));
      if (target && !isObj(target.cache_control)) {
        target.cache_control = cc();
        applied.push("system-block");
        changed = true;
      }
    } else if (typeof msg.content === "string" && !isObj(msg.cache_control)) {
      msg.cache_control = cc();
      applied.push("system-msg");
      changed = true;
    }
  }

  return { changed, applied };
}

/** 请求体里是否真的存在 ttl=1h 的断点。 */
function hasOneHourCache(body: Any): boolean {
  let found = false;
  const walk = (v: unknown) => {
    if (found) return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (!isObj(v)) return;
    if (isObj(v.cache_control) && v.cache_control.ttl === TTL) {
      found = true;
      return;
    }
    for (const x of Object.values(v)) walk(x);
  };
  walk(body?.system);
  walk(body?.messages);
  walk(body?.tools);
  return found;
}

/** 保留客户端已有的 beta 特性，追加 1h TTL 所需的那一个，不重复。 */
function mergeBetaHeader(current: string | null): string {
  const parts = (current ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (!parts.includes(BETA_FLAG)) parts.push(BETA_FLAG);
  return parts.join(",");
}

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers":
    "content-type, x-proxy-token, authorization, x-api-key, anthropic-version, anthropic-beta, anthropic-dangerous-direct-browser-access",
  "access-control-max-age": "86400",
};

/** 不能原样转发给上游的逐跳头/长度头。 */
const STRIP_HEADERS = [
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
  "expect",
  "accept-encoding",
  "x-proxy-token",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
];

const UPSTREAM = (Deno.env.get("UPSTREAM_URL") || DEFAULT_UPSTREAM).replace(/\/+$/, "");
const PROXY_TOKEN = Deno.env.get("PROXY_TOKEN") || "";
const ENABLED = Deno.env.get("CACHE_TTL_ON") !== "0";
const TAIL = Number(Deno.env.get("TAIL_BREAKPOINTS") ?? "2");
const DEBUG = Deno.env.get("DEBUG") === "1";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "content-type": "application/json" },
  });
}

/** 恒定时间比较，避免令牌被逐字符试探。 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 去掉末尾斜杠；根路径归一为 "/"。 */
function normalizePath(pathname: string): string {
  return pathname.replace(/\/+$/, "") || "/";
}

function isMessagesPath(path: string): boolean {
  return path === "/v1/messages" || path === "/messages";
}

function isChatPath(path: string): boolean {
  return path === "/v1/chat/completions" || path === "/chat/completions";
}

/**
 * 拼接上游 URL。上游地址自带 /v1 且客户端也发了 /v1 时去掉一层，
 * 避免出现 /v1/v1/messages。
 */
function resolveUpstream(path: string): string {
  if (!UPSTREAM_HAS_V1) return UPSTREAM + path;
  return UPSTREAM + (path.startsWith("/v1/") ? path.slice(3) : path);
}

async function forward(
  method: string,
  target: string,
  headers: Headers,
  body: BodyInit | null,
  path: string,
  note: string,
): Promise<Response> {
  try {
    const upstream = await fetch(target, {
      method,
      headers,
      body,
      // 透传原始请求体流时必须声明 duplex。
      ...(body !== null && typeof body === "object" ? { duplex: "half" } : {}),
    } as RequestInit);

    if (DEBUG) {
      console.log(`[${PROVIDER}] ${method} ${path} -> ${upstream.status} | ttl=${TTL} | ${note}`);
    }

    // 保留上游响应头，去掉会破坏流式传输和已解码内容的那几个。
    const out = new Headers(upstream.headers);
    out.delete("content-encoding");
    out.delete("content-length");
    out.delete("transfer-encoding");
    out.delete("connection");
    for (const [k, v] of Object.entries(CORS_HEADERS)) out.set(k, v);

    return new Response(upstream.body, { status: upstream.status, headers: out });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[${PROVIDER}] upstream error on ${path}: ${message}`);
    return json({ error: `upstream error: ${message}` }, 502);
  }
}

export async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = normalizePath(url.pathname);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method === "GET" && (path === "/health" || path === "/")) {
    return json({
      ok: true,
      provider: PROVIDER,
      upstream: UPSTREAM,
      upstreamHasV1: UPSTREAM_HAS_V1,
      ttl: TTL,
      injection: ENABLED ? "on" : "off",
      tailBreakpoints: TAIL,
      minCacheTokens: MIN_TOKENS,
    });
  }

  if (PROXY_TOKEN) {
    const supplied = req.headers.get("x-proxy-token") || "";
    if (!safeEqual(supplied, PROXY_TOKEN)) return json({ error: "unauthorized" }, 401);
  }

  const target = resolveUpstream(path) + url.search;
  const headers = new Headers(req.headers);
  for (const h of STRIP_HEADERS) headers.delete(h);

  // 非 JSON 请求体的路径（如 /v1/models）原样透传，不解析不改写。
  const cacheable = req.method === "POST" && (isMessagesPath(path) || isChatPath(path));
  if (!cacheable) {
    return await forward(req.method, target, headers, req.body, path, "passthrough");
  }

  let body: unknown;
  try {
    body = JSON.parse(await req.text());
  } catch {
    return json({ error: "bad json body" }, 400);
  }

  let note = "off";
  if (ENABLED) {
    const result = isMessagesPath(path) ? injectAnthropic(body, TAIL) : injectOpenAI(body);
    note = result.skipped ? `skipped(${result.skipped})` : `applied[${result.applied.join(" ")}]`;
  }

  // 1h TTL 必须声明 beta，否则 ttl 被忽略、按默认 5 分钟计。
  // 只要请求体里存在 ttl=1h 的断点就必须带上，不能只在本代理改写过时才带：
  // 客户端自己已经标好 1h 的情况下注入结果是「无改动」，那时同样需要这个头。
  if (isMessagesPath(path) && hasOneHourCache(body)) {
    headers.set("anthropic-beta", mergeBetaHeader(headers.get("anthropic-beta")));
    note += ` beta[${headers.get("anthropic-beta")}]`;
  } else if (isMessagesPath(path)) {
    note += " beta[none]";
  }

  headers.set("content-type", "application/json");
  return await forward("POST", target, headers, JSON.stringify(body), path, note);
}

export default { fetch: handler };

Deno.serve(handler);
