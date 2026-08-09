/**
 * xyc 1h 缓存断点诊断代理
 *
 * 环境变量 BREAKPOINT_MODE：
 *   system（默认） 删除全部旧断点，只在 system 最后一个可缓存块放 1 个 1h 断点
 *   tools          删除全部旧断点，只在最后一个 tool 放 1 个 1h 断点
 *   message        删除全部旧断点，只在最后一条消息放 1 个 1h 断点
 *   static         删除全部旧断点，在 tools + system 放 1h 断点
 *   all            把请求已有的所有断点升级为 1h
 *   beta           不改断点，只添加 beta 请求头
 *   off            请求体和 beta 请求头均不修改
 *
 * 建议测试顺序：
 *   system -> tools -> static -> message -> all
 */

const UPSTREAM = "https://apicdn.xycai.us";
const TTL = "1h";
const BETA = "extended-cache-ttl-2025-04-11";
const PORT = Number(Deno.env.get("PORT") ?? "8000");

type BreakpointMode =
  | "system"
  | "tools"
  | "message"
  | "static"
  | "all"
  | "beta"
  | "off";

const MODE_VALUES = new Set<BreakpointMode>([
  "system",
  "tools",
  "message",
  "static",
  "all",
  "beta",
  "off",
]);

const rawMode = "message";
const MODE: BreakpointMode = MODE_VALUES.has(rawMode as BreakpointMode)
  ? rawMode as BreakpointMode
  : "system";

const STRIP_HEADERS = [
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "accept-encoding",
];

const CACHEABLE_TYPES = new Set([
  "text",
  "image",
  "document",
  "tool_use",
  "tool_result",
  "search_result",
]);

type AnyObject = Record<string, unknown>;

let seq = 0;
const LINES: string[] = [];

function isObject(value: unknown): value is AnyObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(line: string) {
  LINES.push(line);
  if (LINES.length > 200) LINES.shift();
  console.log(line);
}

function clock(): string {
  return new Date(Date.now() + 8 * 3600 * 1000)
    .toISOString()
    .slice(11, 19);
}

function hash(value: unknown): string {
  const text = typeof value === "string"
    ? value
    : JSON.stringify(value ?? null);

  let h = 5381;

  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  }

  return (h >>> 0).toString(16).padStart(8, "0") + "/" + text.length;
}

function cacheControl() {
  return {
    type: "ephemeral",
    ttl: TTL,
  };
}

function ttlOf(value: unknown): string | null {
  if (!isObject(value)) return null;

  const cc = value.cache_control;
  if (!isObject(cc)) return null;

  return String(cc.ttl ?? "5m");
}

/**
 * 按 Anthropic 实际前缀顺序输出：
 * tools -> system -> messages
 */
function scanBreakpoints(body: AnyObject): string {
  const found: string[] = [];

  if (isObject(body.cache_control)) {
    found.push(`auto:${String(body.cache_control.ttl ?? "5m")}`);
  }

  if (Array.isArray(body.tools)) {
    body.tools.forEach((tool, index) => {
      const ttl = ttlOf(tool);
      if (ttl) found.push(`tool${index}:${ttl}`);
    });
  }

  if (Array.isArray(body.system)) {
    body.system.forEach((block, index) => {
      const ttl = ttlOf(block);
      if (ttl) found.push(`sys${index}:${ttl}`);
    });
  }

  if (Array.isArray(body.messages)) {
    body.messages.forEach((message, messageIndex) => {
      if (!isObject(message)) return;

      const directTTL = ttlOf(message);
      if (directTTL) {
        found.push(`msg${messageIndex}:${directTTL}`);
      }

      if (!Array.isArray(message.content)) return;

      message.content.forEach((block, blockIndex) => {
        const ttl = ttlOf(block);
        if (ttl) {
          found.push(`msg${messageIndex}.${blockIndex}:${ttl}`);
        }
      });
    });
  }

  return found.length === 0
    ? "none"
    : `${found.length}[${found.join(",")}]`;
}

function toBlocks(value: unknown): AnyObject[] | null {
  if (typeof value === "string") {
    if (value.trim() === "") return null;

    return [{
      type: "text",
      text: value,
    }];
  }

  if (!Array.isArray(value)) return null;

  const blocks = value.filter(isObject);
  return blocks.length > 0 ? blocks : null;
}

function lastCacheable(blocks: AnyObject[]): AnyObject | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const type = blocks[i].type;

    if (
      typeof type === "string" &&
      CACHEABLE_TYPES.has(type)
    ) {
      return blocks[i];
    }
  }

  return null;
}

/**
 * 删除所有可能影响实验的显式/自动断点。
 * 只处理 Anthropic 定义的断点宿主，不递归修改 tool schema。
 */
function stripAllBreakpoints(body: AnyObject): number {
  let removed = 0;

  if (isObject(body.cache_control)) {
    delete body.cache_control;
    removed++;
  }

  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (!isObject(tool) || !isObject(tool.cache_control)) continue;

      delete tool.cache_control;
      removed++;
    }
  }

  if (Array.isArray(body.system)) {
    for (const block of body.system) {
      if (!isObject(block) || !isObject(block.cache_control)) continue;

      delete block.cache_control;
      removed++;
    }
  }

  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (!isObject(message)) continue;

      if (isObject(message.cache_control)) {
        delete message.cache_control;
        removed++;
      }

      if (!Array.isArray(message.content)) continue;

      for (const block of message.content) {
        if (!isObject(block) || !isObject(block.cache_control)) continue;

        delete block.cache_control;
        removed++;
      }
    }
  }

  return removed;
}

function markLastTool(body: AnyObject): boolean {
  if (!Array.isArray(body.tools)) return false;

  for (let i = body.tools.length - 1; i >= 0; i--) {
    const tool = body.tools[i];
    if (!isObject(tool)) continue;

    tool.cache_control = cacheControl();
    return true;
  }

  return false;
}

function markLastSystemBlock(body: AnyObject): boolean {
  const blocks = toBlocks(body.system);
  if (!blocks) return false;

  const target = lastCacheable(blocks);
  if (!target) return false;

  body.system = blocks;
  target.cache_control = cacheControl();

  return true;
}

function markLastMessageBlock(body: AnyObject): boolean {
  if (!Array.isArray(body.messages)) return false;

  for (let i = body.messages.length - 1; i >= 0; i--) {
    const message = body.messages[i];
    if (!isObject(message)) continue;

    const blocks = toBlocks(message.content);
    if (!blocks) continue;

    const target = lastCacheable(blocks);
    if (!target) continue;

    message.content = blocks;
    target.cache_control = cacheControl();

    return true;
  }

  return false;
}

function upgradeExistingBreakpoints(body: AnyObject): number {
  let changed = 0;

  const upgrade = (holder: unknown) => {
    if (!isObject(holder)) return;

    const cc = holder.cache_control;
    if (!isObject(cc)) return;

    holder.cache_control = {
      ...cc,
      type: "ephemeral",
      ttl: TTL,
    };

    changed++;
  };

  if (isObject(body.cache_control)) {
    body.cache_control = {
      ...body.cache_control,
      type: "ephemeral",
      ttl: TTL,
    };

    changed++;
  }

  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) upgrade(tool);
  }

  if (Array.isArray(body.system)) {
    for (const block of body.system) upgrade(block);
  }

  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (!isObject(message)) continue;

      upgrade(message);

      if (Array.isArray(message.content)) {
        for (const block of message.content) upgrade(block);
      }
    }
  }

  return changed;
}

function applyBreakpointMode(body: AnyObject): string {
  if (MODE === "off") {
    return "off";
  }

  if (MODE === "beta") {
    return "beta-only";
  }

  if (MODE === "all") {
    const upgraded = upgradeExistingBreakpoints(body);
    return `all:upgraded=${upgraded}`;
  }

  const removed = stripAllBreakpoints(body);

  if (MODE === "system") {
    const system = markLastSystemBlock(body);
    return `system:removed=${removed},added=${system ? 1 : 0}`;
  }

  if (MODE === "tools") {
    const tools = markLastTool(body);
    return `tools:removed=${removed},added=${tools ? 1 : 0}`;
  }

  if (MODE === "message") {
    const message = markLastMessageBlock(body);
    return `message:removed=${removed},added=${message ? 1 : 0}`;
  }

  if (MODE === "static") {
    const tools = markLastTool(body);
    const system = markLastSystemBlock(body);
    const added = Number(tools) + Number(system);

    return `static:removed=${removed},added=${added}`;
  }

  return "unknown";
}

function mergeBetaHeader(current: string | null): string {
  const parts = (current ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  if (!parts.includes(BETA)) {
    parts.push(BETA);
  }

  return parts.join(",");
}

Deno.serve({ port: PORT }, async (req: Request) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/logs") {
    return new Response(
      LINES.length === 0 ? "暂无记录。" : LINES.join("\n\n"),
      {
        headers: {
          "content-type": "text/plain; charset=utf-8",
        },
      },
    );
  }

  if (path === "/logs/clear") {
    LINES.length = 0;

    return new Response("已清空。", {
      headers: {
        "content-type": "text/plain; charset=utf-8",
      },
    });
  }

  if (path === "/health" || path === "/") {
    return new Response(
      JSON.stringify({
        ok: true,
        upstream: UPSTREAM,
        breakpointMode: MODE,
        ttl: TTL,
        beta: MODE === "off" ? "unchanged" : BETA,
        lines: LINES.length,
      }),
      {
        headers: {
          "content-type": "application/json",
        },
      },
    );
  }

  const headers = new Headers(req.headers);

  for (const name of STRIP_HEADERS) {
    headers.delete(name);
  }

  const isMessages =
    req.method === "POST" &&
    (path === "/v1/messages" || path === "/messages");

  if (!isMessages) {
    const response = await fetch(UPSTREAM + path + url.search, {
      method: req.method,
      headers,
      body: req.body,
      ...(req.body ? { duplex: "half" } : {}),
    } as RequestInit);

    return new Response(response.body, {
      status: response.status,
      headers: response.headers,
    });
  }

  const id = ++seq;

  let body: AnyObject;

  try {
    body = JSON.parse(await req.text());
  } catch {
    record(`#${id} ${clock()} ERR bad-json`);

    return new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "bad json",
        },
      }),
      {
        status: 400,
        headers: {
          "content-type": "application/json",
        },
      },
    );
  }

  const betaIn = headers.get("anthropic-beta") ?? "-";
  const bpIn = scanBreakpoints(body);

  const messages = Array.isArray(body.messages)
    ? body.messages
    : [];

  const roles = messages
    .map((message) => {
      if (!isObject(message)) return "?";
      return String(message.role ?? "?")[0];
    })
    .join("");

  const apply = applyBreakpointMode(body);

  if (MODE !== "off") {
    headers.set(
      "anthropic-beta",
      mergeBetaHeader(headers.get("anthropic-beta")),
    );
  }

  const betaOut = headers.get("anthropic-beta") ?? "-";
  const bpOut = scanBreakpoints(body);

  headers.set("content-type", "application/json");

  const head = [
    `#${id}`,
    clock(),
    `mode=${MODE}`,
    `model=${body.model ?? "?"}`,
    `sys=${hash(body.system)}`,
    `tools=${hash(body.tools)}`,
    `msgs=${messages.length}:${roles}`,
    `stream=${body.stream === true}`,
    `bpIn=${bpIn}`,
    `bpOut=${bpOut}`,
    `apply=${apply}`,
    `betaIn=${betaIn}`,
    `betaOut=${betaOut}`,
  ].join(" ");

  let response: Response;

  try {
    response = await fetch(UPSTREAM + path + url.search, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : String(error);

    record(`${head}\n  FETCH-ERR ${message}`);

    return new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "api_error",
          message: "upstream unreachable",
        },
      }),
      {
        status: 502,
        headers: {
          "content-type": "application/json",
        },
      },
    );
  }

  const outputHeaders = new Headers(response.headers);

  outputHeaders.delete("content-encoding");
  outputHeaders.delete("content-length");
  outputHeaders.delete("transfer-encoding");
  outputHeaders.delete("connection");

  if (!response.body) {
    record(
      `${head}\n  status=${response.status} NO-BODY ct=${
        response.headers.get("content-type")
      }`,
    );

    return new Response(null, {
      status: response.status,
      headers: outputHeaders,
    });
  }

  const [toClient, toLog] = response.body.tee();

  (async () => {
    try {
      const text = await new Response(toLog).text();

      const pick = (key: string) => {
        const match = new RegExp(
          `"${key}"\\s*:\\s*(\\d+)`,
        ).exec(text);

        return match ? match[1] : "-";
      };

      const usage = [
        `status=${response.status}`,
        `len=${text.length}`,
        `read=${pick("cache_read_input_tokens")}`,
        `create=${pick("cache_creation_input_tokens")}`,
        `w1h=${pick("ephemeral_1h_input_tokens")}`,
        `w5m=${pick("ephemeral_5m_input_tokens")}`,
        `in=${pick("input_tokens")}`,
        `out=${pick("output_tokens")}`,
      ].join(" ");

      const raw = pick("input_tokens") === "-"
        ? `\n  RAW ct=${
          response.headers.get("content-type")
        } <${text.slice(0, 800).replace(/\s+/g, " ")}>`
        : "";

      record(`${head}\n  ${usage}${raw}`);
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : String(error);

      record(`${head}\n  usage-err ${message}`);
    }
  })();

  return new Response(toClient, {
    status: response.status,
    headers: outputHeaders,
  });
});
