/**
 * xyc 中转站 · 1h 提示词缓存注入代理（Deno Deploy Playground 单文件版）
 *
 * 上游：https://apicdn.xycai.us（地址不带 /v1）
 * LobeHub 的 Anthropic Base URL 填 https://你的项目名.deno.dev（后面不要再加 /v1）
 *
 * 环境变量（Settings 里加）：
 *   DEBUG             设为 "1" 打印诊断日志（排查期间必须开）
 *   TAIL_BREAKPOINTS  会话尾部断点数，排查期间设为 "0"
 *   UPSTREAM_URL      覆盖上游地址
 *   PROXY_TOKEN       访问令牌，设了之后请求必须带 x-proxy-token
 *   CACHE_TTL_ON      设为 "0" 临时关闭注入，方便对比
 *   MIN_CACHE_TOKENS  建缓存的最小前缀 token 数，默认 1200
 */

const PROVIDER = "xyc";
const DEFAULT_UPSTREAM = "https://apicdn.xycai.us";
/** 上游地址是否已经包含 /v1 前缀。xyc 不含，所以是 false。 */
const UPSTREAM_HAS_V1 = false;

const TTL = "1h";

/** Anthropic 单请求最多 4 个 cache 断点。 */
const MAX_BREAKPOINTS = 4;

/** 低于这个 token 数就不插断点，Anthropic 会直接拒绝太短的前缀。 */
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

/** 粗略估算 token 数：CJK 一字约一 token，其余按四字符一 token。 */
function approxTokens(v: unknown): number {
  let cjk = 0;
  let other = 0;
  const walk = (x: unknown) => {
    if (typeof x === "string") {
      for (const ch of x) {
        const c = ch.codePointAt(0)!;
        if (c > 0x2e80) cjk++;
        else other++;
      }
    } else if (Array.isArray(x)) {
      for (const y of x) walk(y);
    } else if (isObj(x)) {
      for (const y of Object.values(x)) walk(y);
    }
  };
  walk(v);
  return cjk + Math.ceil(other / 4);
}

function totalTokens(body: Any): number {
  return approxTokens(body?.system) + approxTokens(body?.tools) +
    approxTokens(body?.messages);
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

function lastCacheable(
  blocks: Record<string, Any>[],
): Record<string, Any> | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const t = blocks[i].type;
    if (typeof t === "string" && CACHEABLE_TYPES.has(t)) return blocks[i];
  }
  return null;
}

interface InjectResult {
  changed: boolean;
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

  const holders = existingHolders(body);
  for (const h of holders) {
    if (h.cache_control.ttl !== TTL) {
      h.cache_control = { ...h.cache_control, type: "ephemeral", ttl: TTL };
      changed = true;
    }
  }
  if (holders.length > 0) applied.push(`upgraded:${holders.length}`);

  const total = totalTokens(body);
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

  // 缓存前缀是「断点之前的累计内容」，所以每个候选位置都要按自己的前缀长度判断。
  const toolsTok = approxTokens(body?.tools);
  const systemTok = approxTokens(body?.system);

  if (budget > 0 && Array.isArray(body.tools) && body.tools.length > 0) {
    const last = body.tools.filter(isObj).at(-1);
    if (last && !isObj(last.cache_control)) {
      if (toolsTok >= MIN_TOKENS) mark(last, "tools");
      else applied.push(`skip-tools:${toolsTok}tok`);
    }
  }

  if (budget > 0 && body.system !== undefined) {
    const blocks = toBlocks(body.system);
    const target = blocks && lastCacheable(blocks);
    if (blocks && target && !isObj(target.cache_control)) {
      const prefix = toolsTok + systemTok;
      if (prefix >= MIN_TOKENS) {
        body.system = blocks;
        mark(target, "system");
      } else {
        applied.push(`skip-system:${prefix}tok`);
      }
    }
  }

  if (budget > 0 && tailBreakpoints > 0 && Array.isArray(body.messages)) {
    const msgs = body.messages as Any[];
    const cum: number[] = [];
    let run = toolsTok + systemTok;
    for (const m of msgs) {
      run += approxTokens(m);
      cum.push(run);
    }

    let placed = 0;
    for (
      let i = msgs.length - 1;
      i >= 0 && placed < tailBreakpoints && budget > 0;
      i--
    ) {
      if (cum[i] < MIN_TOKENS) {
        applied.push(`skip-msgs:${cum[i]}tok`);
        break;
      }
      const msg = msgs[i];
      if (!isObj(msg)) continue;
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

/** OpenAI 兼容通道，保守处理：只给 system 消息挂断点。 */
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

  const total = totalTokens(body);
  if (total < MIN_TOKENS) {
    return { changed, applied, skipped: `too-small:${total}<${MIN_TOKENS}tok` };
  }
  if (!Array.isArray(body.messages)) {
    return { changed, applied, skipped: "no-messages" };
  }

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

/** 请求体里是否真的存在 ttl=1h 的断点。beta 头按这个判断。 */
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

function fnv(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, "0");
}

function partHash(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v ?? null);
  return `${fnv(s)}/${s.length}`;
}

/**
 * 缓存前缀由 model + tools + system + 前置消息共同决定，
 * 任何一项变了都会整体 miss。所以这几项要分开记，不能只记 system。
 */
function requestFingerprint(body: Any): string {
  const msgs: Any[] = Array.isArray(body?.messages) ? body.messages : [];
  const roles = msgs
    .map((m) => (isObj(m) ? String(m.role ?? "?").charAt(0) : "?"))
    .join("");
  return [
    `model=${body?.model ?? "?"}`,
    `sys=${partHash(body?.system)}`,
    `tools=${partHash(body?.tools)}`,
    `msgs=${msgs.length}:${roles}`,
    `head2=${partHash(msgs.slice(0, 2))}`,
  ].join(" ");
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

/** 不能原样转发给上游的逐跳头 / 长度头。 */
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

const UPSTREAM = (Deno.env.get("UPSTREAM_URL") || DEFAULT_UPSTREAM).replace(
  /\/+$/,
  "",
);
const PROXY_TOKEN = Deno.env.get("PROXY_TOKEN") || "";
const ENABLED = Deno.env.get("CACHE_TTL_ON") !== "0";
const TAIL = Number(Deno.env.get("TAIL_BREAKPOINTS") ?? "2");
const DEBUG = Deno.env.get("D
}  return new Response(JSON.stringify(data), {
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

function normalizePath(pathname: string): string {
  return pathname.replace(/\/+$/, "") || "/";
}

function isMessagesPath(path: string): boolean {
  return path === "/v1/messages" || path === "/messages";
}

function isChatPath(path: string): boolean {
  return path === "/v1/chat/completions" || path === "/chat/completions";
}

/** 拼接上游 URL，避免出现 /v1/v1/messages。 */
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
      ...(body !== null && typeof body === "object" ? { duplex: "half" } : {}),
    } as RequestInit);

    if (DEBUG) {
      console.log(
        `[${PROVIDER}] ${method} ${path} -> ${upstream.status} | ttl=${TTL} | ${note}`,
      );
    }

    const out = new Headers(upstream.headers);
    out.delete("content-encoding");
    out.delete("content-length");
    out.delete("transfer-encoding");
    out.delete("connection");
    for (const [k, v] of Object.entries(CORS_HEADERS)) out.set(k, v);

    // 用 tee 把响应分两路：一路原样给客户端（不影响流式），一路只用来读 usage。
    if (DEBUG && upstream.ok && upstream.body && isMessagesPath(path)) {
      const [forClient, forLog] = upstream.body.tee();
      void (async () => {
        try {
          const text = await new Response(forLog).text();
          const pick = (k: string) =>
            new RegExp(`"${k}"\\s*:\\s*(\\d+)`).exec(text)?.[1] ?? "-";
          console.log(
            `[${PROVIDER}] usage read=${pick("cache_read_input_tokens")}` +
              ` w1h=${pick("ephemeral_1h_input_tokens")}` +
              ` w5m=${pick("ephemeral_5m_input_tokens")}` +
              ` input=${pick("input_tokens")}`,
          );
        } catch (err) {
          console.log(`[${PROVIDER}] usage read failed: ${err}`);
        }
      })();
      return new Response(forClient, { status: upstream.status, headers: out });
    }

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
      ttl: TTL,
      injection: ENABLED ? "on" : "off",
      tailBreakpoints: TAIL,
      minCacheTokens: MIN_TOKENS,
      debug: DEBUG,
    });
  }

  if (PROXY_TOKEN) {
    const supplied = req.headers.get("x-proxy-token") || "";
    if (!safeEqual(supplied, PROXY_TOKEN)) {
      return json({ error: "unauthorized" }, 401);
    }
  }

  const target = resolveUpstream(path) + url.search;
  const headers = new Headers(req.headers);
  for (const h of STRIP_HEADERS) headers.delete(h);

  const cacheable = req.method === "POST" &&
    (isMessagesPath(path) || isChatPath(path));
  if (!cacheable) {
    return await forward(req.method, target, headers, req.body, path, "passthrough");
  }

  let body: unknown;
  try {
    body = JSON.parse(await req.text());
  } catch {
    return json({ error: "bad json body" }, 400);
  }

  // 注入前先记指纹：命中失败时用来判断是不是前缀每轮都在变。
  if (DEBUG && isMessagesPath(path)) {
    console.log(`[${PROVIDER}] req ${requestFingerprint(body)}`);
  }

  let note = "off";
  if (ENABLED) {
    const result = isMessagesPath(path)
      ? injectAnthropic(body, TAIL)
      : injectOpenAI(body);
    note = result.skipped
      ? `skipped(${result.skipped})`
      : `applied[${result.applied.join(" ")}]`;
  }

  // 1h TTL 必须声明 beta，否则 ttl 被忽略、按默认 5 分钟计费。
  if (isMessagesPath(path)) {
    if (hasOneHourCache(body)) {
      headers.set("anthropic-beta", mergeBetaHeader(headers.get("anthropic-beta")));
      note += ` beta[${headers.get("anthropic-beta")}]`;
    } else {
      note += " beta[none]";
    }
  }

  headers.set("content-type", "application/json");
  return await forward("POST", target, headers, JSON.stringify(body), path, note);
}

Deno.serve(handler);