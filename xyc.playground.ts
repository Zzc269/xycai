/**
 * xyc single-message 1h cache proxy for Deno Deploy Playground.
 *
 * Strategy:
 * - Keep tools, system, and messages in their original Anthropic fields.
 * - Remove all incoming cache_control markers from known Anthropic locations.
 * - Add exactly one 1h marker to the latest cacheable message content block.
 * - The marker caches the complete prefix before it: tools + system + messages.
 * - Retry an upstream HTTP 502 with the exact same serialized body.
 * - Never read, clone, or tee a successful response stream.
 *
 * Optional environment variables:
 *   UPSTREAM_URL       Default: https://apicdn.xycai.us
 *   PROXY_TOKEN        Optional access token, received as x-proxy-token
 *   MAX_502_RETRIES    Default: 2 (three total attempts)
 *   DEBUG              Set to 1 for console logs
 */

const PROVIDER = "xyc";
const DEFAULT_UPSTREAM = "https://apicdn.xycai.us";
const BETA_FLAG = "extended-cache-ttl-2025-04-11";
const TTL = "1h";

const UPSTREAM = (Deno.env.get("UPSTREAM_URL") || DEFAULT_UPSTREAM).replace(/\/+$/, "");
const PROXY_TOKEN = Deno.env.get("PROXY_TOKEN") || "";
const DEBUG = Deno.env.get("DEBUG") === "1";
const MAX_502_RETRIES = clampInteger(
  Number(Deno.env.get("MAX_502_RETRIES") ?? "2"),
  0,
  4,
);

const RETRY_DELAYS_MS = [500, 1500, 3000, 5000];
const MAX_LOG_LINES = 200;
const LOGS = [];

const CACHEABLE_TYPES = new Set([
  "text",
  "image",
  "document",
  "tool_use",
  "tool_result",
  "search_result",
]);

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers":
    "content-type, x-proxy-token, authorization, x-api-key, anthropic-version, anthropic-beta, anthropic-dangerous-direct-browser-access",
  "access-control-expose-headers":
    "x-cache-proxy-attempts, x-cache-proxy-breakpoint",
  "access-control-max-age": "86400",
};

const STRIP_REQUEST_HEADERS = [
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

function clampInteger(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clock() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(11, 19);
}

function record(line) {
  const value = `${clock()} ${line}`;
  LOGS.push(value);
  if (LOGS.length > MAX_LOG_LINES) LOGS.shift();
  console.log(value);
}

function json(data, status = 200, extraHeaders = undefined) {
  const headers = new Headers(CORS_HEADERS);
  headers.set("content-type", "application/json; charset=utf-8");
  if (extraHeaders) {
    for (const [name, value] of Object.entries(extraHeaders)) {
      headers.set(name, String(value));
    }
  }
  return new Response(JSON.stringify(data), { status, headers });
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) {
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return difference === 0;
}

function normalizePath(pathname) {
  return pathname.replace(/\/+$/, "") || "/";
}

function isMessagesPath(path) {
  return path === "/v1/messages" || path === "/messages";
}

function cleanRequestHeaders(source) {
  const headers = new Headers(source);
  for (const name of STRIP_REQUEST_HEADERS) headers.delete(name);
  return headers;
}

function cleanResponseHeaders(source, attempts, breakpoint) {
  const headers = new Headers(source);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  headers.delete("connection");
  for (const [name, value] of Object.entries(CORS_HEADERS)) {
    headers.set(name, value);
  }
  headers.set("x-cache-proxy-attempts", String(attempts));
  headers.set("x-cache-proxy-breakpoint", breakpoint);
  return headers;
}

function mergeBetaHeader(current) {
  const values = (current ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!values.includes(BETA_FLAG)) values.push(BETA_FLAG);
  return values.join(",");
}

/** Remove cache markers only from valid top-level Anthropic holder locations. */
function stripCacheControls(body) {
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

function lastCacheableBlock(blocks) {
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index];
    if (!isObject(block)) continue;
    if (typeof block.type !== "string") continue;
    if (CACHEABLE_TYPES.has(block.type)) return { block, index };
  }
  return null;
}

/**
 * Add one marker to the latest cacheable message block.
 * A string message is converted to the equivalent Anthropic text block array.
 */
function markLatestMessage(body) {
  if (!Array.isArray(body.messages)) return null;

  for (let messageIndex = body.messages.length - 1; messageIndex >= 0; messageIndex--) {
    const message = body.messages[messageIndex];
    if (!isObject(message)) continue;

    if (typeof message.content === "string") {
      if (message.content.trim() === "") continue;
      message.content = [{
        type: "text",
        text: message.content,
        cache_control: { type: "ephemeral", ttl: TTL },
      }];
      return `msg${messageIndex}.0:text`;
    }

    if (!Array.isArray(message.content)) continue;
    const target = lastCacheableBlock(message.content);
    if (!target) continue;

    target.block.cache_control = { type: "ephemeral", ttl: TTL };
    return `msg${messageIndex}.${target.index}:${target.block.type}`;
  }

  return null;
}

/** Fallback only for malformed/unusual requests without a cacheable message. */
function markSystemFallback(body) {
  if (typeof body.system === "string" && body.system.trim() !== "") {
    body.system = [{
      type: "text",
      text: body.system,
      cache_control: { type: "ephemeral", ttl: TTL },
    }];
    return "system0:text(fallback)";
  }

  if (!Array.isArray(body.system)) return null;
  const target = lastCacheableBlock(body.system);
  if (!target) return null;
  target.block.cache_control = { type: "ephemeral", ttl: TTL };
  return `system${target.index}:${target.block.type}(fallback)`;
}

function injectSingleBreakpoint(body) {
  const removed = stripCacheControls(body);
  const breakpoint = markLatestMessage(body) ?? markSystemFallback(body);
  return {
    removed,
    breakpoint,
    changed: removed > 0 || breakpoint !== null,
  };
}

function extractRequestId(text) {
  const match = /request id:\s*([^\s)"}]+)/i.exec(text);
  return match ? match[1] : "-";
}

async function passthrough(req, target, path) {
  const headers = cleanRequestHeaders(req.headers);
  const hasBody = req.method !== "GET" && req.method !== "HEAD";

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      ...(hasBody ? { body: req.body, duplex: "half" } : {}),
    });
    if (DEBUG) record(`${req.method} ${path} -> ${upstream.status} passthrough`);
    return new Response(upstream.body, {
      status: upstream.status,
      headers: cleanResponseHeaders(upstream.headers, 1, "none"),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    record(`${req.method} ${path} fetch-error=${message}`);
    return json({
      type: "error",
      error: { type: "api_error", message: "upstream unreachable" },
    }, 502);
  }
}

/** Retry only a fetch failure or an upstream HTTP 502. */
async function forwardMessages(target, headers, payload, meta) {
  const totalAttempts = MAX_502_RETRIES + 1;
  let lastErrorText = "";
  let lastErrorHeaders = new Headers({ "content-type": "application/json" });
  let lastFetchError = "";

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    let upstream;

    try {
      upstream = await fetch(target, {
        method: "POST",
        headers,
        body: payload,
      });
    } catch (error) {
      lastFetchError = error instanceof Error ? error.message : String(error);
      record(
        `model=${meta.model} breakpoint=${meta.breakpoint} attempt=${attempt}/${totalAttempts} ` +
          `fetch-error=${lastFetchError}`,
      );

      if (attempt < totalAttempts) {
        await sleep(RETRY_DELAYS_MS[attempt - 1] ?? 5000);
        continue;
      }

      return json({
        type: "error",
        error: { type: "api_error", message: "upstream unreachable after retries" },
      }, 502, {
        "x-cache-proxy-attempts": attempt,
        "x-cache-proxy-breakpoint": meta.breakpoint,
      });
    }

    if (upstream.status !== 502) {
      record(
        `model=${meta.model} breakpoint=${meta.breakpoint} removed=${meta.removed} ` +
          `attempt=${attempt}/${totalAttempts} status=${upstream.status}`,
      );

      // Successful/non-502 response streams are passed through untouched.
      return new Response(upstream.body, {
        status: upstream.status,
        headers: cleanResponseHeaders(upstream.headers, attempt, meta.breakpoint),
      });
    }

    // Read only the 502 error response so it can be logged and retried.
    lastErrorText = await upstream.text();
    lastErrorHeaders = new Headers(upstream.headers);
    const requestId = extractRequestId(lastErrorText);

    record(
      `model=${meta.model} breakpoint=${meta.breakpoint} removed=${meta.removed} ` +
        `attempt=${attempt}/${totalAttempts} status=502 requestId=${requestId}`,
    );

    if (attempt < totalAttempts) {
      await sleep(RETRY_DELAYS_MS[attempt - 1] ?? 5000);
    }
  }

  const outputHeaders = cleanResponseHeaders(
    lastErrorHeaders,
    totalAttempts,
    meta.breakpoint,
  );

  if (!lastErrorText && lastFetchError) {
    lastErrorText = JSON.stringify({
      type: "error",
      error: { type: "api_error", message: lastFetchError },
    });
  }

  return new Response(lastErrorText, {
    status: 502,
    headers: outputHeaders,
  });
}

async function handler(req) {
  const url = new URL(req.url);
  const path = normalizePath(url.pathname);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method === "GET" && (path === "/" || path === "/health")) {
    return json({
      ok: true,
      provider: PROVIDER,
      upstream: UPSTREAM,
      strategy: "single-latest-message-prefix",
      ttl: TTL,
      beta: BETA_FLAG,
      max502Retries: MAX_502_RETRIES,
      successfulResponseInspection: false,
      logLines: LOGS.length,
    });
  }

  if (req.method === "GET" && path === "/logs") {
    return new Response(LOGS.length ? LOGS.join("\n\n") : "No logs.", {
      headers: { ...CORS_HEADERS, "content-type": "text/plain; charset=utf-8" },
    });
  }

  if (req.method === "POST" && path === "/logs/clear") {
    LOGS.length = 0;
    return json({ ok: true, cleared: true });
  }

  if (PROXY_TOKEN) {
    const supplied = req.headers.get("x-proxy-token") || "";
    if (!safeEqual(supplied, PROXY_TOKEN)) {
      return json({ error: "unauthorized" }, 401);
    }
  }

  const target = UPSTREAM + path + url.search;

  if (req.method !== "POST" || !isMessagesPath(path)) {
    return await passthrough(req, target, path);
  }

  let body;
  try {
    body = JSON.parse(await req.text());
  } catch {
    return json({
      type: "error",
      error: { type: "invalid_request_error", message: "bad json body" },
    }, 400);
  }

  if (!isObject(body)) {
    return json({
      type: "error",
      error: { type: "invalid_request_error", message: "JSON body must be an object" },
    }, 400);
  }

  const injection = injectSingleBreakpoint(body);
  if (!injection.breakpoint) {
    return json({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "no cacheable message or system block found",
      },
    }, 400);
  }

  const payload = JSON.stringify(body);
  const headers = cleanRequestHeaders(req.headers);
  headers.set("content-type", "application/json");
  headers.set(
    "anthropic-beta",
    mergeBetaHeader(headers.get("anthropic-beta")),
  );

  return await forwardMessages(target, headers, payload, {
    model: String(body.model ?? "?"),
    breakpoint: injection.breakpoint,
    removed: injection.removed,
  });
}

export default { fetch: handler };
Deno.serve(handler);
