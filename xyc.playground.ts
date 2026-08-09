/**
 * xyc 中转站 · Claude 1h 全前缀缓存 + 当前时间注入 + 原始响应诊断
 * Deno Deploy Playground 单文件版
 *
 * LobeHub Anthropic Base URL：
 *   https://你的项目名.deno.dev
 *
 * 默认行为：
 *   1. tools、system、最近两条消息最多使用 4 个 1h cache breakpoint
 *   2. 在最后一条 user 消息的缓存断点之后追加当前时间（时间块本身不缓存）
 *   3. 每个入站请求只向 xyc 发起 1 次请求，绝不自动重试
 *   4. /logs 显示断点、缓存 usage、失败原文和请求编号
 *
 * 可选环境变量：
 *   UPSTREAM_URL        默认 https://apicdn.xycai.us
 *   PROXY_TOKEN         可选访问令牌；设置后请求需带 x-proxy-token
 *   CACHE_TTL_ON        "0" = 不改缓存；默认开启
 *   TAIL_BREAKPOINTS    最近消息断点数；默认 2，建议 1~2
 *   INJECT_CURRENT_TIME "0" = 不注入当前时间；默认开启
 *   TIME_ZONE           默认 Asia/Shanghai
 *   DEBUG               "1" = 成功请求也实时打印详细日志
 */

const PROVIDER = "xyc";
const DEFAULT_UPSTREAM = "https://apicdn.xycai.us";
const TTL = "1h";
const BETA_FLAG = "extended-cache-ttl-2025-04-11";
const MAX_BREAKPOINTS = 4;
const MIN_CHARS = 2000;
const RUNTIME_MARKER = "xyc-proxy-runtime-time-v1";

// deno-lint-ignore no-explicit-any
type Any = any;

const UPSTREAM = (Deno.env.get("UPSTREAM_URL") || DEFAULT_UPSTREAM).replace(/\/+$/, "");
const PROXY_TOKEN = Deno.env.get("PROXY_TOKEN") || "";
const CACHE_ENABLED = Deno.env.get("CACHE_TTL_ON") !== "0";
const TIME_ENABLED = Deno.env.get("INJECT_CURRENT_TIME") !== "0";
const TIME_ZONE = Deno.env.get("TIME_ZONE") || "Asia/Shanghai";
const DEBUG = Deno.env.get("DEBUG") === "1";

const parsedTail = Number(Deno.env.get("TAIL_BREAKPOINTS") ?? "2");
const TAIL_BREAKPOINTS = Number.isFinite(parsedTail)
  ? Math.max(0, Math.min(2, Math.trunc(parsedTail)))
  : 2;

const CACHEABLE_TYPES = new Set([
  "text",
  "image",
  "document",
  "tool_use",
  "tool_result",
  "search_result",
]);

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers":
    "content-type, x-proxy-token, authorization, x-api-key, anthropic-version, anthropic-beta, anthropic-dangerous-direct-browser-access",
  "access-control-expose-headers": "x-proxy-request-id",
  "access-control-max-age": "86400",
};

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
  "x-proxy-request-id",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
];

const LOG_LINES: string[] = [];
let sequence = 0;

function isObj(v: unknown): v is Record<string, Any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function json(data: unknown, status = 200, requestId = ""): Response {
  const headers = new Headers({
    ...CORS_HEADERS,
    "content-type": "application/json; charset=utf-8",
  });
  if (requestId) headers.set("x-proxy-request-id", requestId);
  return new Response(JSON.stringify(data), { status, headers });
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
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

function resolveUpstream(path: string): string {
  return UPSTREAM + path;
}

function formatTime(date = new Date()): string {
  try {
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone: TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

function clock(): string {
  return formatTime().replace("T", " ");
}

function record(line: string, forceConsole = false): void {
  LOG_LINES.push(line);
  if (LOG_LINES.length > 300) LOG_LINES.shift();
  if (DEBUG || forceConsole) console.log(line);
}

function shortHash(v: unknown): string {
  let s: string;
  try {
    s = typeof v === "string" ? v : JSON.stringify(v ?? null);
  } catch {
    s = String(v);
  }
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return `${(h >>> 0).toString(16).padStart(8, "0")}/${s.length}`;
}

function cc() {
  return { type: "ephemeral", ttl: TTL };
}

function approxChars(body: Any): number {
  let n = 0;
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      n += v.length;
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x);
    } else if (isObj(v)) {
      for (const x of Object.values(v)) walk(x);
    }
  };
  walk(body?.system);
  walk(body?.messages);
  walk(body?.tools);
  return n;
}

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
    const type = blocks[i].type;
    if (typeof type === "string" && CACHEABLE_TYPES.has(type)) return blocks[i];
  }
  return null;
}

/**
 * 如果上一次代理时间块被某个客户端意外保存进了历史，请先移除。
 * 正常 LobeHub 不会保存代理改写后的请求，此处只是防御性处理。
 */
function removeOldRuntimeBlocks(body: Any): number {
  if (!Array.isArray(body?.messages)) return 0;
  let removed = 0;
  for (const msg of body.messages) {
    if (!isObj(msg) || !Array.isArray(msg.content)) continue;
    const before = msg.content.length;
    msg.content = msg.content.filter((block: unknown) => {
      return !(
        isObj(block) &&
        block.type === "text" &&
        typeof block.text === "string" &&
        block.text.includes(RUNTIME_MARKER)
      );
    });
    removed += before - msg.content.length;
  }
  return removed;
}

interface InjectResult {
  changed: boolean;
  applied: string[];
  skipped?: string;
}

/**
 * 全缓存模式：保留 LobeHub 的已有断点并全部升级成 1h，
 * 再按 tools -> system -> 最近消息补足，最多 4 个。
 */
function injectAnthropic(body: Any, tailBreakpoints: number): InjectResult {
  const applied: string[] = [];
  let changed = false;

  const holders = existingHolders(body);
  for (const holder of holders) {
    const old = holder.cache_control;
    if (old?.type !== "ephemeral" || old?.ttl !== TTL) {
      holder.cache_control = cc();
      changed = true;
    }
  }
  if (holders.length > 0) applied.push(`upgraded:${holders.length}`);

  const chars = approxChars(body);
  if (chars < MIN_CHARS) {
    return { changed, applied, skipped: `too-small:${chars}<${MIN_CHARS}` };
  }

  let budget = MAX_BREAKPOINTS - holders.length;
  if (budget <= 0) {
    return { changed, applied, skipped: holders.length > MAX_BREAKPOINTS ? "too-many-existing-breakpoints" : "no-budget" };
  }

  const mark = (holder: Record<string, Any>, label: string) => {
    holder.cache_control = cc();
    applied.push(label);
    budget--;
    changed = true;
  };

  if (budget > 0 && Array.isArray(body.tools) && body.tools.length > 0) {
    const tool = body.tools.filter(isObj).at(-1);
    if (tool && !isObj(tool.cache_control)) mark(tool, "tools");
  }

  if (budget > 0 && body.system !== undefined) {
    const blocks = toBlocks(body.system);
    const target = blocks && lastCacheable(blocks);
    if (blocks && target && !isObj(target.cache_control)) {
      body.system = blocks;
      mark(target, "system");
    }
  }

  if (budget > 0 && tailBreakpoints > 0 && Array.isArray(body.messages)) {
    let placed = 0;
    for (
      let i = body.messages.length - 1;
      i >= 0 && placed < tailBreakpoints && budget > 0;
      i--
    ) {
      const msg = body.messages[i];
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

function injectOpenAI(body: Any): InjectResult {
  const applied: string[] = [];
  let changed = false;

  const holders = existingHolders(body);
  for (const holder of holders) {
    const old = holder.cache_control;
    if (old?.type !== "ephemeral" || old?.ttl !== TTL) {
      holder.cache_control = cc();
      changed = true;
    }
  }
  if (holders.length > 0) applied.push(`upgraded:${holders.length}`);

  if (approxChars(body) < MIN_CHARS) {
    return { changed, applied, skipped: "too-small" };
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
      applied.push("system-message");
      changed = true;
    }
  }

  return { changed, applied };
}

/**
 * 必须在 injectAnthropic() 之后调用。
 * 新时间块位于最新缓存断点之后，且它自己绝不带 cache_control。
 */
function appendCurrentTime(body: Any): { added: boolean; reason?: string } {
  if (!Array.isArray(body?.messages) || body.messages.length === 0) {
    return { added: false, reason: "no-messages" };
  }

  const last = body.messages.at(-1);
  if (!isObj(last) || last.role !== "user") {
    return { added: false, reason: "last-not-user" };
  }

  if (typeof last.content === "string") {
    last.content = [{ type: "text", text: last.content }];
  }
  if (!Array.isArray(last.content)) {
    return { added: false, reason: "unsupported-content" };
  }

  const now = new Date();
  last.content.push({
    type: "text",
    text:
      `<!-- ${RUNTIME_MARKER} -->\n` +
      `<runtime_context source="request_proxy">\n` +
      `当前时间：${formatTime(now)}\n` +
      `时区：${TIME_ZONE}\n` +
      `Unix 毫秒：${now.getTime()}\n` +
      `这是代理自动加入的运行时信息，不是用户原文。` +
      `仅在问题涉及现在、今天、日期、时限或相对时间时使用。\n` +
      `</runtime_context>`,
  });
  return { added: true };
}

function mergeBetaHeader(current: string | null): string {
  const parts = (current ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.includes(BETA_FLAG)) parts.push(BETA_FLAG);
  return parts.join(",");
}

function scanBreakpoints(body: Any): string {
  const found: string[] = [];
  const ttlOf = (v: unknown): string | null => {
    if (!isObj(v) || !isObj(v.cache_control)) return null;
    return String(v.cache_control.ttl ?? "5m");
  };

  if (Array.isArray(body?.tools)) {
    body.tools.forEach((tool: unknown, i: number) => {
      const ttl = ttlOf(tool);
      if (ttl) found.push(`tool${i}:${ttl}`);
    });
  }
  if (Array.isArray(body?.system)) {
    body.system.forEach((block: unknown, i: number) => {
      const ttl = ttlOf(block);
      if (ttl) found.push(`sys${i}:${ttl}`);
    });
  }
  if (Array.isArray(body?.messages)) {
    body.messages.forEach((msg: unknown, i: number) => {
      if (!isObj(msg) || !Array.isArray(msg.content)) return;
      msg.content.forEach((block: unknown, j: number) => {
        const ttl = ttlOf(block);
        if (ttl) found.push(`msg${i}.${j}:${ttl}`);
      });
    });
  }

  return found.length === 0 ? "none" : `${found.length}[${found.join(",")}]`;
}

function rolesOf(body: Any): string {
  if (!Array.isArray(body?.messages)) return "-";
  return body.messages.map((msg: unknown) => {
    if (!isObj(msg)) return "?";
    return String(msg.role ?? "?").slice(0, 1);
  }).join("");
}

function responseHeaders(source: Headers, requestId: string): Headers {
  const out = new Headers(source);
  out.delete("content-encoding");
  out.delete("content-length");
  out.delete("transfer-encoding");
  out.delete("connection");
  for (const [key, value] of Object.entries(CORS_HEADERS)) out.set(key, value);
  out.set("x-proxy-request-id", requestId);
  return out;
}

function readUsage(text: string, key: string): string {
  const pattern = new RegExp(`"${key}"\\s*:\\s*(\\d+)`, "g");
  let value = "-";
  for (const match of text.matchAll(pattern)) value = match[1];
  return value;
}

interface ForwardMeta {
  id: string;
  head: string;
  path: string;
}

/**
 * 注意：这里只有一次 fetch，没有循环、退避或自动重试。
 */
async function forwardOnce(
  method: string,
  target: string,
  headers: Headers,
  body: BodyInit | null,
  signal: AbortSignal,
  meta: ForwardMeta,
): Promise<Response> {
  let upstream: Response;
  const started = performance.now();
  try {
    upstream = await fetch(target, {
      method,
      headers,
      body,
      signal,
      ...(body !== null && typeof body === "object" ? { duplex: "half" } : {}),
    } as RequestInit);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const line = `${meta.head}\n  attempt=1 FETCH-ERR ${message}`;
    record(line, true);
    return json({ error: `upstream error: ${message}` }, 502, meta.id);
  }

  const elapsed = Math.round(performance.now() - started);
  const out = responseHeaders(upstream.headers, meta.id);

  if (!upstream.body) {
    const line = `${meta.head}\n  attempt=1 status=${upstream.status} ms=${elapsed} no-body`;
    record(line, !upstream.ok);
    return new Response(null, { status: upstream.status, headers: out });
  }

  const [toClient, toLog] = upstream.body.tee();
  void (async () => {
    try {
      const text = await new Response(toLog).text();
      const input = readUsage(text, "input_tokens");
      const usage = [
        `attempt=1`,
        `status=${upstream.status}`,
        `ms=${elapsed}`,
        `len=${text.length}`,
        `read=${readUsage(text, "cache_read_input_tokens")}`,
        `create=${readUsage(text, "cache_creation_input_tokens")}`,
        `w1h=${readUsage(text, "ephemeral_1h_input_tokens")}`,
        `w5m=${readUsage(text, "ephemeral_5m_input_tokens")}`,
        `in=${input}`,
        `out=${readUsage(text, "output_tokens")}`,
      ].join(" ");

      const raw = !upstream.ok || input === "-"
        ? `\n  RAW ct=${upstream.headers.get("content-type") ?? "-"} <${
          text.slice(0, 600).replace(/\s+/g, " ")
        }>`
        : "";
      record(`${meta.head}\n  ${usage}${raw}`, !upstream.ok);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record(`${meta.head}\n  attempt=1 usage-log-error=${message}`, true);
    }
  })();

  return new Response(toClient, { status: upstream.status, headers: out });
}

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = normalizePath(url.pathname);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (PROXY_TOKEN) {
    const supplied = req.headers.get("x-proxy-token") || url.searchParams.get("proxy_token") || "";
    if (!safeEqual(supplied, PROXY_TOKEN)) return json({ error: "unauthorized" }, 401);
  }
  // 允许浏览器用 ?proxy_token=... 查看诊断页，但绝不把令牌转发给上游。
  url.searchParams.delete("proxy_token");

  if (req.method === "GET" && (path === "/" || path === "/health")) {
    return json({
      ok: true,
      provider: PROVIDER,
      upstream: UPSTREAM,
      cache: CACHE_ENABLED ? `${TTL}/all` : "passthrough",
      beta: CACHE_ENABLED ? BETA_FLAG : "not-added",
      tailBreakpoints: TAIL_BREAKPOINTS,
      currentTimeInjection: TIME_ENABLED,
      timeZone: TIME_ZONE,
      upstreamAttemptsPerIncomingRequest: 1,
      logsInThisInstance: LOG_LINES.length,
    });
  }

  if (req.method === "GET" && path === "/logs") {
    return new Response(
      LOG_LINES.length === 0 ? "暂无记录。" : LOG_LINES.join("\n\n"),
      { headers: { ...CORS_HEADERS, "content-type": "text/plain; charset=utf-8" } },
    );
  }

  if ((req.method === "GET" || req.method === "POST") && path === "/logs/clear") {
    LOG_LINES.length = 0;
    return new Response("已清空", {
      headers: { ...CORS_HEADERS, "content-type": "text/plain; charset=utf-8" },
    });
  }

  const id = `${++sequence}-${crypto.randomUUID().slice(0, 8)}`;
  const target = resolveUpstream(path) + url.search;
  const headers = new Headers(req.headers);
  for (const header of STRIP_HEADERS) headers.delete(header);
  headers.set("x-proxy-request-id", id);

  const rewriteable = req.method === "POST" && (isMessagesPath(path) || isChatPath(path));
  if (!rewriteable) {
    const head = `#${id} ${clock()} path=${path} passthrough`;
    return await forwardOnce(req.method, target, headers, req.body, req.signal, {
      id,
      head,
      path,
    });
  }

  let body: Any;
  try {
    body = JSON.parse(await req.text());
  } catch {
    record(`#${id} ${clock()} path=${path} bad-json`, true);
    return json({ error: "bad json body" }, 400, id);
  }

  const inputHash = shortHash({
    model: body?.model,
    system: body?.system,
    tools: body?.tools,
    messages: body?.messages,
  });
  const betaIn = headers.get("anthropic-beta") ?? "-";
  const bpIn = scanBreakpoints(body);
  const removedRuntime = removeOldRuntimeBlocks(body);

  let cacheNote = "off";
  if (CACHE_ENABLED) {
    const result = isMessagesPath(path)
      ? injectAnthropic(body, TAIL_BREAKPOINTS)
      : injectOpenAI(body);
    cacheNote = result.skipped
      ? `skipped(${result.skipped}) applied[${result.applied.join(" ")}]`
      : `applied[${result.applied.join(" ")}]`;

    // 只要缓存功能开启，Anthropic 原生路径就始终补 beta。
    // 不能只在 body 发生变化时补，否则“请求原本已经是 1h”时会漏头。
    if (isMessagesPath(path)) {
      headers.set("anthropic-beta", mergeBetaHeader(headers.get("anthropic-beta")));
    }
  }

  let timeNote = "off";
  if (TIME_ENABLED && isMessagesPath(path)) {
    const result = appendCurrentTime(body);
    timeNote = result.added ? "added-after-cache" : `skipped(${result.reason})`;
  }

  headers.set("content-type", "application/json");

  const messageCount = Array.isArray(body?.messages) ? body.messages.length : 0;
  const head = [
    `#${id}`,
    clock(),
    `path=${path}`,
    `model=${body?.model ?? "?"}`,
    `prompt=${inputHash}`,
    `msgs=${messageCount}:${rolesOf(body)}`,
    `stream=${body?.stream === true}`,
    `bpIn=${bpIn}`,
    `bpOut=${scanBreakpoints(body)}`,
    `cache=${cacheNote}`,
    `time=${timeNote}`,
    removedRuntime > 0 ? `oldTimeRemoved=${removedRuntime}` : "",
    `betaIn=${betaIn}`,
    `betaOut=${headers.get("anthropic-beta") ?? "-"}`,
  ].filter(Boolean).join(" ");

  return await forwardOnce(
    "POST",
    target,
    headers,
    JSON.stringify(body),
    req.signal,
    { id, head, path },
  );
}

Deno.serve(handler);
