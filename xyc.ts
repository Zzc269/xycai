// xyc 1h 缓存注入代理 · 带 /logs 网页查看
// Runtime configuration: Dynamic App
// 不需要设置任何环境变量

const UPSTREAM = "https://apicdn.xycai.us";
const TTL = "1h";
const BETA = "extended-cache-ttl-2025-04-11";

const STRIP = [
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "accept-encoding",
];

let seq = 0;
const LINES: string[] = [];

function record(line: string) {
  LINES.push(line);
  if (LINES.length > 200) LINES.shift();
  console.log(line);
}

function hash(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v ?? null);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, "0") + "/" + s.length;
}

function clock(): string {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(11, 19);
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const path = url.pathname;

  // 浏览器打开这个地址看日志
  if (path === "/logs") {
    const text = LINES.length === 0
      ? "暂无记录，先去 LobeHub 聊几轮再刷新。"
      : LINES.join("\n");
    return new Response(text, {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  if (path === "/logs/clear") {
    LINES.length = 0;
    return new Response("已清空", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  if (path === "/health") {
    const info = { ok: true, ttl: TTL, lines: LINES.length, upstream: UPSTREAM };
    return new Response(JSON.stringify(info), {
      headers: { "content-type": "application/json" },
    });
  }

  const headers = new Headers(req.headers);
  for (const h of STRIP) headers.delete(h);

  const isMessages = req.method === "POST" &&
    (path === "/v1/messages" || path === "/messages");

  if (!isMessages) {
    const res = await fetch(UPSTREAM + path + url.search, {
      method: req.method,
      headers,
      body: req.body,
      ...(req.body ? { duplex: "half" } : {}),
    } as RequestInit);
    return new Response(res.body, { status: res.status, headers: res.headers });
  }

  const id = ++seq;

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await req.text());
  } catch {
    record(`#${id} ${clock()} ERR bad-json`);
    return new Response('{"error":"bad json"}', { status: 400 });
  }

  const clientBeta = headers.get("anthropic-beta") ?? "-";
  const rawType = typeof body.system;
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const roles = msgs
    .map((m) =>
      m && typeof m === "object"
        ? String((m as Record<string, unknown>).role ?? "?")[0]
        : "?"
    )
    .join("");

  let apply = "none";
  if (typeof body.system === "string" && body.system.trim() !== "") {
    body.system = [{ type: "text", text: body.system }];
  }
  const sys = body.system;
  if (Array.isArray(sys) && sys.length > 0) {
    const last = sys[sys.length - 1];
    if (last && typeof last === "object") {
      (last as Record<string, unknown>).cache_control = {
        type: "ephemeral",
        ttl: TTL,
      };
      apply = `system[${sys.length - 1}]`;
    }
  }

  if (apply !== "none") {
    const parts = (headers.get("anthropic-beta") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "");
    if (!parts.includes(BETA)) parts.push(BETA);
    headers.set("anthropic-beta", parts.join(","));
  }
  const sentBeta = headers.get("anthropic-beta") ?? "-";

  headers.set("content-type", "application/json");

  const head = [
    `#${id}`,
    clock(),
    `model=${body.model ?? "?"}`,
    `sysType=${rawType}`,
    `sys=${hash(body.system)}`,
    `tools=${hash(body.tools)}`,
    `msgs=${msgs.length}:${roles}`,
    `head2=${hash(msgs.slice(0, 2))}`,
    `tail1=${hash(msgs.slice(-1))}`,
    `stream=${body.stream === true}`,
    `apply=${apply}`,
    `betaIn=${clientBeta}`,
    `betaOut=${sentBeta}`,
  ].join(" ");

  let res: Response;
  try {
    res = await fetch(UPSTREAM + path + url.search, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (e) {
    record(`${head} | FETCH-ERR ${e instanceof Error ? e.message : e}`);
    return new Response('{"error":"upstream unreachable"}', { status: 502 });
  }

  const out = new Headers(res.headers);
  out.delete("content-encoding");
  out.delete("content-length");

  if (!res.ok || !res.body) {
    record(`${head} | status=${res.status} usage=unread`);
    return new Response(res.body, { status: res.status, headers: out });
  }

  const [toClient, toLog] = res.body.tee();
  (async () => {
    try {
      const text = await new Response(toLog).text();
      const pick = (k: string) => {
        const m = new RegExp('"' + k + '"\\s*:\\s*(\\d+)').exec(text);
        return m ? m[1] : "-";
      };
      const tail = [
        `status=${res.status}`,
        `read=${pick("cache_read_input_tokens")}`,
        `w1h=${pick("ephemeral_1h_input_tokens")}`,
        `w5m=${pick("ephemeral_5m_input_tokens")}`,
        `in=${pick("input_tokens")}`,
        `out=${pick("output_tokens")}`,
      ].join(" ");
      record(`${head} | ${tail}`);
    } catch (e) {
      record(`${head} | usage-err ${e instanceof Error ? e.message : e}`);
    }
  })();

  return new Response(toClient, { status: res.status, headers: out });
});