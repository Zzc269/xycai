const PROVIDER = "xyc";
const DEFAULT_UPSTREAM = "https://cn.chatapi.app";
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
const BREAKPOINT_MODE = (Deno.env.get("BREAKPOINT_MODE") || "message").toLowerCase();
const TIME_ENABLED = Deno.env.get("INJECT_CURRENT_TIME") !== "0";
const TIME_ZONE = Deno.env.get("TIME_ZONE") || "Asia/Shanghai";
const DEBUG = Deno.env.get("DEBUG") === "1";
const FORCE_NON_STREAM = Deno.env.get("FORCE_NON_STREAM") !== "0";

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

function formatTime(date = new Date(), includeSeconds = false): string {
  try {
    const options: Intl.DateTimeFormatOptions = {
      timeZone: TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    };
    if (includeSeconds) options.second = "2-digit";
    return new Intl.DateTimeFormat("sv-SE", options).format(date);
  } catch {
    return date.toISOString();
  }
}

function clock(): string {
  return formatTime(new Date(), true).replace("T", " ");
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

/**
 * 璇婃柇鍝堝笇蹇界暐 cache_control 鍜屼唬鐞嗘椂闂村潡銆�
 * 鍥犳涓ゆ鏃ュ織鐨勫搱甯屼笉鍚屾椂锛屼唬琛ㄧ湡瀹炴彁绀哄唴瀹瑰彂鐢熶簡鍙樺寲銆�
 */
function diagnosticValue(v: unknown): unknown {
  if (Array.isArray(v)) {
    return v
      .filter((item) => !(
        isObj(item) &&
        item.type === "text" &&
        typeof item.text === "string" &&
        item.text.includes(RUNTIME_MARKER)
      ))
      .map(diagnosticValue);
  }
  if (!isObj(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(v)) {
    if (key === "cache_control") continue;
    out[key] = diagnosticValue(value);
  }
  return out;
}

function diagnosticHash(v: unknown): string {
  return shortHash(diagnosticValue(v));
}

function messageHashes(body: Any): string {
  if (!Array.isArray(body?.messages)) return "-";
  return body.messages.map((msg: unknown, index: number) => {
    if (!isObj(msg)) return `${index}?:invalid`;
    const role = String(msg.role ?? "?").slice(0, 1);
    return `${index}${role}:${diagnosticHash(msg.content)}`;
  }).join(",");
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
 * 濡傛灉涓婁竴娆′唬鐞嗘椂闂村潡琚煇涓鎴风鎰忓淇濆瓨杩涗簡鍘嗗彶锛岃鍏堢Щ闄ゃ€�
 * 姝ｅ父 LobeHub 涓嶄細淇濆瓨浠ｇ悊鏀瑰啓鍚庣殑璇锋眰锛屾澶勫彧鏄槻寰℃€у鐞嗐€�
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
 * 鍗� message 鏂偣妯″紡銆�
 * 鍏堢Щ闄� LobeHub 鑷甫鐨� 5m 鏂偣锛岄伩鍏嶆棫 5m 鐖剁紦瀛樺拰鏂� 1h 澧為噺娣风敤锛�
 * 鍐嶆妸鍞竴鐨� 1h 鏂偣鏀惧埌鏈€鏂版秷鎭殑鏈€鍚庝竴涓彲缂撳瓨鍧椼€�
 */
function injectAnthropicMessage(body: Any): InjectResult {
  const holders = existingHolders(body);
  for (const holder of holders) delete holder.cache_control;

  const applied: string[] = [];
  let changed = holders.length > 0;
  if (holders.length > 0) applied.push(`removed:${holders.length}`);

  const chars = approxChars(body);
  if (chars < MIN_CHARS) {
    return { changed, applied, skipped: `too-small:${chars}<${MIN_CHARS}` };
  }
  if (!Array.isArray(body?.messages) || body.messages.length === 0) {
    return { changed, applied, skipped: "no-messages" };
  }

  for (let i = body.messages.length - 1; i >= 0; i--) {
    const msg = body.messages[i];
    if (!isObj(msg)) continue;
    const blocks = toBlocks(msg.content);
    const target = blocks && lastCacheable(blocks);
    if (!blocks || !target) continue;
    msg.content = blocks;
    target.cache_control = cc();
    applied.push(`msg[${i}]:${msg.role ?? "?"}`);
    changed = true;
    return { changed, applied };
  }

  return { changed, applied, skipped: "no-cacheable-message-block" };
}

/**
 * 澶氭柇鐐瑰吋瀹规ā寮忥細淇濈暀 LobeHub 鐨勫凡鏈夋柇鐐瑰苟鍏ㄩ儴鍗囩骇鎴� 1h锛�
 * 鍐嶆寜 tools -> system -> 鏈€杩戞秷鎭ˉ瓒筹紝鏈€澶� 4 涓€�
 */
function injectAnthropicAll(body: Any, tailBreakpoints: number): InjectResult {
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
 * 蹇呴』鍦� injectAnthropic() 涔嬪悗璋冪敤銆�
 * 鏂版椂闂村潡浣嶄簬鏈€鏂扮紦瀛樻柇鐐逛箣鍚庯紝涓斿畠鑷繁缁濅笉甯� cache_control銆�
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
      `褰撳墠鏃堕棿锛�${formatTime(now)}\n` +
      `鏃跺尯锛�${TIME_ZONE}\n` +
      `杩欐槸浠ｇ悊鑷姩鍔犲叆鐨勮繍琛屾椂淇℃伅锛屼笉鏄敤鎴峰師鏂囥€俙 +
      `浠呭湪闂娑夊強鐜板湪銆佷粖澶┿€佹棩鏈熴€佹椂闄愭垨鐩稿鏃堕棿鏃朵娇鐢ㄣ€俓n` +
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
  convertSse?: boolean;
}

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}`;
}

/**
 * 鎶婁笂娓歌繑鍥炵殑瀹屾暣 JSON锛堥潪娴佸紡 message 鍝嶅簲锛夎浆鎴� Anthropic SSE 浜嬩欢娴併€�
 * 鏀寔 text / thinking / tool_use 鍐呭鍧楋紝浠ュ強閿欒瀵硅薄銆�
 */
function toSse(text: string): string {
  let parsed: Any;
  try {
    parsed = JSON.parse(text);
  } catch {
    return `${sseFrame("error", { type: "error", error: { type: "parse_error", message: text.slice(0, 500) } })}\n\n`;
  }
  if (!isObj(parsed)) {
    return `${sseFrame("error", { type: "error", error: { type: "invalid_response", message: text.slice(0, 500) } })}\n\n`;
  }
  if (isObj(parsed.error)) {
    return `${sseFrame("error", { type: "error", error: parsed.error })}\n\n`;
  }

  const events: string[] = [];
  events.push(sseFrame("message_start", {
    type: "message_start",
    message: { ...parsed, content: [] },
  }));

  const blocks = Array.isArray(parsed.content) ? parsed.content : [];
  blocks.forEach((block: unknown, index: number) => {
    if (!isObj(block)) return;
    const start: Any = { type: "content_block_start", index, content_block: { ...block } };
    if (block.type === "text") start.content_block.text = "";
    if (block.type === "tool_use") start.content_block.input = undefined;
    events.push(sseFrame("content_block_start", start));

    if (block.type === "text" && typeof block.text === "string") {
      events.push(sseFrame("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: block.text },
      }));
    } else if (block.type === "thinking" && typeof block.thinking === "string") {
      events.push(sseFrame("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "thinking_delta", thinking: block.thinking },
      }));
    } else if (block.type === "tool_use") {
      events.push(sseFrame("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) },
      }));
    }

    events.push(sseFrame("content_block_stop", { type: "content_block_stop", index }));
  });

  events.push(sseFrame("message_delta", {
    type: "message_delta",
    delta: { stop_reason: parsed.stop_reason ?? null, stop_sequence: parsed.stop_sequence ?? null },
    usage: parsed.usage ?? {},
  }));
  events.push(sseFrame("message_stop", { type: "message_stop" }));
  return events.join("\n\n") + "\n\n";
}

/**
 * 娉ㄦ剰锛氳繖閲屽彧鏈変竴娆� fetch锛屾病鏈夊惊鐜€侀€€閬挎垨鑷姩閲嶈瘯銆�
 * 鏂规 A锛氫笉鍐嶆帴鏀� / 浼犻€� AbortSignal锛堝幓鎺変簡 req.signal锛夛紝閬垮厤
 * Deno.serve legacy 琛屼负涓� request.signal 鍦ㄥ搷搴旈€佽揪鍚庤Е鍙� abort銆�
 * convertSse 妯″紡涓嬶細璇诲畬鏁� JSON -> 杞� SSE -> 鍥炵粰瀹㈡埛绔€�
 */
async function forwardOnce(
  method: string,
  target: string,
  headers: Headers,
  body: BodyInit | null,
  meta: ForwardMeta,
): Promise<Response> {
  let upstream: Response;
  const started = performance.now();
  try {
    upstream = await fetch(target, {
      method,
      headers,
      body,
      ...(body !== null && typeof body === "object" ? { duplex: "half" } : {}),
    } as RequestInit);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const line = `${meta.head}\n  attempt=1 FETCH-ERR ${message}`;
    record(line, true);
    return json({ error: `upstream error: ${message}` }, 502, meta.id);
  }

  const elapsed = Math.round(performance.now() - started);

  if (meta.convertSse) {
    // 涓婃父鎸� stream=false 杩斿洖瀹屾暣 JSON锛岃繖閲岃鍙栧悗杞垚 SSE 浜嬩欢娴�
    let text = "";
    try {
      text = await new Response(upstream.body).text();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record(`${meta.head}\n  attempt=1 convert-read-error=${message}`, true);
      return json({ error: `upstream read error: ${message}` }, 502, meta.id);
    }
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
      ? `\n  RAW ct=${upstream.headers.get("content-type") ?? "-"} <${text.slice(0, 600).replace(/\s+/g, " ")}>`
      : "";
    record(`${meta.head}\n  ${usage}${raw}`, !upstream.ok);

    const out = responseHeaders(upstream.headers, meta.id);
    out.set("content-type", "text/event-stream; charset=utf-8");
    return new Response(toSse(text), { status: upstream.status, headers: out });
  }

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
  // 鍏佽娴忚鍣ㄧ敤 ?proxy_token=... 鏌ョ湅璇婃柇椤碉紝浣嗙粷涓嶆妸浠ょ墝杞彂缁欎笂娓搞€�
  url.searchParams.delete("proxy_token");

  if (req.method === "GET" && (path === "/" || path === "/health")) {
    return json({
      ok: true,
      provider: PROVIDER,
      upstream: UPSTREAM,
      cache: CACHE_ENABLED ? `${TTL}/${BREAKPOINT_MODE}` : "passthrough",
      beta: CACHE_ENABLED ? BETA_FLAG : "not-added",
      tailBreakpoints: TAIL_BREAKPOINTS,
      currentTimeInjection: TIME_ENABLED,
      timeZone: TIME_ZONE,
      forceNonStream: FORCE_NON_STREAM,
      upstreamAttemptsPerIncomingRequest: 1,
      logsInThisInstance: LOG_LINES.length,
    });
  }

  if (req.method === "GET" && path === "/logs") {
    return new Response(
      LOG_LINES.length === 0 ? "鏆傛棤璁板綍銆�" : LOG_LINES.join("\n\n"),
      { headers: { ...CORS_HEADERS, "content-type": "text/plain; charset=utf-8" } },
    );
  }

  if ((req.method === "GET" || req.method === "POST") && path === "/logs/clear") {
    LOG_LINES.length = 0;
    return new Response("宸叉竻绌�", {
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
    return await forwardOnce(req.method, target, headers, req.body, {
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
      ? (BREAKPOINT_MODE === "all"
        ? injectAnthropicAll(body, TAIL_BREAKPOINTS)
        : injectAnthropicMessage(body))
      : injectOpenAI(body);
    cacheNote = result.skipped
      ? `skipped(${result.skipped}) applied[${result.applied.join(" ")}]`
      : `applied[${result.applied.join(" ")}]`;

    // 鍙缂撳瓨鍔熻兘寮€鍚紝Anthropic 鍘熺敓璺緞灏卞缁堣ˉ beta銆�
    // 涓嶈兘鍙湪 body 鍙戠敓鍙樺寲鏃惰ˉ锛屽惁鍒�"璇锋眰鍘熸湰宸茬粡鏄� 1h"鏃朵細婕忓ご銆�
    if (isMessagesPath(path)) {
      headers.set("anthropic-beta", mergeBetaHeader(headers.get("anthropic-beta")));
    }
  }

  let timeNote = "off";
  if (TIME_ENABLED && isMessagesPath(path)) {
    const result = appendCurrentTime(body);
    timeNote = result.added ? "added-after-cache" : `skipped(${result.reason})`;
  }

  // v2锛氬己鍒堕潪娴佸紡锛堜粎 Anthropic messages 璺緞 + 鍏ョ珯涓烘祦寮忔椂锛�
  let streamNote = "passthrough";
  let convertSse = false;
  if (FORCE_NON_STREAM && isMessagesPath(path) && body?.stream === true) {
    body.stream = false;
    streamNote = "forced-false+sse";
    convertSse = true;
  }

  headers.set("content-type", "application/json");

  const messageCount = Array.isArray(body?.messages) ? body.messages.length : 0;
  const head = [
    `#${id}`,
    clock(),
    `path=${path}`,
    `model=${body?.model ?? "?"}`,
    `prompt=${inputHash}`,
    `sys=${diagnosticHash(body?.system)}`,
    `tools=${diagnosticHash(body?.tools)}`,
    `mh=${messageHashes(body)}`,
    `msgs=${messageCount}:${rolesOf(body)}`,
    `stream=${body?.stream === true}`,
    `force=${streamNote}`,
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
    { id, head, path, convertSse },
  );
}

Deno.serve(handler);
