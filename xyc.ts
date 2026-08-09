/**
 * xyc 极简 1h 缓存注入代理
 *
 * 只执行：
 * 1. 将 LobeHub 已有的 cache_control 原位升级为 ttl: "1h"
 * 2. 添加 anthropic-beta: extended-cache-ttl-2025-04-11
 *
 * 不新增、删除或移动任何缓存断点。
 * 不读取或 tee 上游响应流。
 */

const UPSTREAM = "https://apicdn.xycai.us";
const BETA = "extended-cache-ttl-2025-04-11";
const PORT = Number(Deno.env.get("PORT") ?? "8000");

const STRIP_HEADERS = [
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "accept-encoding",
];

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value);
}

function upgradeHolder(value: unknown): number {
  if (!isObject(value)) return 0;

  const current = value.cache_control;
  if (!isObject(current)) return 0;

  value.cache_control = {
    ...current,
    type: "ephemeral",
    ttl: "1h",
  };

  return 1;
}

/**
 * 只检查 Anthropic 官方允许放置断点的位置。
 * 不递归扫描，避免误改 tool schema 内的同名字段。
 */
function upgradeExistingBreakpoints(body: JsonObject): number {
  let upgraded = 0;

  // 顶层自动缓存配置（如果客户端带了）
  if (isObject(body.cache_control)) {
    body.cache_control = {
      ...body.cache_control,
      type: "ephemeral",
      ttl: "1h",
    };

    upgraded++;
  }

  // tools
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      upgraded += upgradeHolder(tool);
    }
  }

  // system
  if (Array.isArray(body.system)) {
    for (const block of body.system) {
      upgraded += upgradeHolder(block);
    }
  }

  // messages
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (!isObject(message)) continue;

      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          upgraded += upgradeHolder(block);
        }
      }
    }
  }

  return upgraded;
}

function mergeBetaHeader(current: string | null): string {
  const values = (current ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (!values.includes(BETA)) {
    values.push(BETA);
  }

  return values.join(",");
}

function cleanRequestHeaders(source: Headers): Headers {
  const headers = new Headers(source);

  for (const name of STRIP_HEADERS) {
    headers.delete(name);
  }

  return headers;
}

function cleanResponseHeaders(source: Headers): Headers {
  const headers = new Headers(source);

  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  headers.delete("connection");

  return headers;
}

async function passthrough(req: Request, url: URL): Promise<Response> {
  const headers = cleanRequestHeaders(req.headers);
  const hasBody = req.method !== "GET" && req.method !== "HEAD";

  const response = await fetch(
    UPSTREAM + url.pathname + url.search,
    {
      method: req.method,
      headers,
      ...(hasBody
        ? {
          body: req.body,
          duplex: "half",
        }
        : {}),
    } as RequestInit,
  );

  return new Response(response.body, {
    status: response.status,
    headers: cleanResponseHeaders(response.headers),
  });
}

Deno.serve({ port: PORT }, async (req: Request) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/" || path === "/health") {
    return new Response(
      JSON.stringify({
        ok: true,
        upstream: UPSTREAM,
        strategy: "upgrade-existing-breakpoints-only",
        ttl: "1h",
        beta: BETA,
      }),
      {
        headers: {
          "content-type": "application/json; charset=utf-8",
        },
      },
    );
  }

  const isMessagesRequest =
    req.method === "POST" &&
    (path === "/v1/messages" || path === "/messages");

  if (!isMessagesRequest) {
    return await passthrough(req, url);
  }

  let body: JsonObject;

  try {
    body = JSON.parse(await req.text());
  } catch {
    return new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "bad json body",
        },
      }),
      {
        status: 400,
        headers: {
          "content-type": "application/json; charset=utf-8",
        },
      },
    );
  }

  const upgraded = upgradeExistingBreakpoints(body);
  const headers = cleanRequestHeaders(req.headers);

  headers.set("content-type", "application/json");
  headers.set(
    "anthropic-beta",
    mergeBetaHeader(headers.get("anthropic-beta")),
  );

  console.log(
    [
      "[cache-proxy]",
      `model=${String(body.model ?? "?")}`,
      `breakpoints=${upgraded}`,
      `beta=${headers.get("anthropic-beta")}`,
    ].join(" "),
  );

  let response: Response;

  try {
    response = await fetch(
      UPSTREAM + path + url.search,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      },
    );
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : String(error);

    console.error(`[cache-proxy] fetch-error=${message}`);

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
          "content-type": "application/json; charset=utf-8",
        },
      },
    );
  }

  console.log(
    `[cache-proxy] model=${String(body.model ?? "?")} ` +
      `breakpoints=${upgraded} status=${response.status}`,
  );

  return new Response(response.body, {
    status: response.status,
    headers: cleanResponseHeaders(response.headers),
  });
});
