/**
 * LobeHub -> Anthropic 1h Cache 注入代理（Deno Deploy 云版）
 *
 * 部署：Deno Deploy（deno.com），免费，无需 Cloudflare
 * 环境变量：
 *   UPSTREAM_URL  上游 Anthropic 兼容端点（默认 https://apicdn.xycai.us）
 *   PROXY_TOKEN   访问令牌（可选，设置后请求必须带 x-proxy-token 头）
 *
 * LobeHub 侧配置（anthropic 源）：
 *   Base URL: https://你的项目名.deno.dev/v1
 */

const UPSTREAM = Deno.env.get("UPSTREAM_URL") || "https://apicdn.xycai.us";
const TOKEN = Deno.env.get("PROXY_TOKEN") || "";
const TTL = "1h";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-proxy-token, authorization, anthropic-version, anthropic-beta",
  "Access-Control-Max-Age": "86400",
};

function addTtlAnthropic(body: any) {
  if (Array.isArray(body.system)) {
    for (const block of body.system) {
      if (block?.cache_control && typeof block.cache_control === "object") {
        if (!block.cache_control.ttl) block.cache_control.ttl = TTL;
      }
    }
  }
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block && typeof block === "object" && block.cache_control && typeof block.cache_control === "object") {
            if (!block.cache_control.ttl) block.cache_control.ttl = TTL;
          }
        }
      }
    }
  }
}

function addTtlOpenAI(body: any) {
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (msg?.role === "system") {
        if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block?.cache_control && typeof block.cache_control === "object") {
              if (!block.cache_control.ttl) block.cache_control.ttl = TTL;
            }
          }
        } else if (typeof msg.content === "string" && !msg.cache_control) {
          msg.cache_control = { type: "ephemeral", ttl: TTL };
        }
      }
    }
  }
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "content-type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const path = url.pathname;

  // CORS 预检
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // 健康检查
  if (req.method === "GET" && path === "/health") {
    return json({ ok: true, upstream: UPSTREAM, ttl: TTL, region: "deno-deploy" });
  }

  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  // 令牌校验（设置了 PROXY_TOKEN 时启用）
  if (TOKEN && req.headers.get("x-proxy-token") !== TOKEN) {
    return json({ error: "unauthorized" }, 401);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad json body" }, 400);
  }

  let rewritten = false;
  if (path === "/v1/messages") {
    addTtlAnthropic(body);
    rewritten = true;
  } else if (path === "/v1/chat/completions") {
    addTtlOpenAI(body);
    rewritten = true;
  }

  const headers = new Headers(req.headers);
  headers.delete("host");
  headers.set("content-type", req.headers.get("content-type") || "application/json");

  const upstreamPath = path === "/v1/chat/completions" ? "/v1/chat/completions" : "/v1/messages";

  console.log(`${path} -> ${UPSTREAM}${upstreamPath} | ttl=${TTL} rewritten=${rewritten} model=${body.model || "?"}`);

  try {
    const upRes = await fetch(UPSTREAM + upstreamPath, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    // 流式透传（SSE）
    return new Response(upRes.body, {
      status: upRes.status,
      headers: {
        ...CORS_HEADERS,
        "content-type": upRes.headers.get("content-type") || "application/json",
      },
    });
  } catch (e) {
    console.error(`upstream error: ${e.message}`);
    return json({ error: `upstream error: ${e.message}` }, 502);
  }
});
