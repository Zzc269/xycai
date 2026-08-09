// xyc 1h 缓存注入代理 · 单行全量日志版
// Runtime configuration: Dynamic App
// 环境变量可以一个都不设，默认就开日志

const UPSTREAM = "https://apicdn.xycai.us";
const TTL = "1h";
const BETA = "extended-cache-ttl-2025-04-11";
const LOG = Deno.env.get("DEBUG") !== "0";

const STRIP = [
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "accept-encoding",
];

let seq = 0;

function hash(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v ?? null);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, "0") + "/" + s.length;
}

function clock(): string {
  return new Date().toISOString().slice(11, 19);
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/health") {
    const info = { ok: true, ttl: TTL, log: LOG, upstream: UPSTREAM };
    return new Response(JSON.stringify(info), {
      headers: { "content-type": "application/json" },
    });
  }

  const headers = new Headers(req.headers);
  for (const h of STRIP) headers.delete(h);

  const isMessages = req.method === "POST" &&
    (path === "/v1/messages" || path === "/messages");

  // 非 messages 请求原样转发，不打日志
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
    console.log(`#${id} ${clock()} ERR bad-json`);
    return new Response('{"error":"bad json"}', { status: 400 });
  }

  // 记录进来时的原始状态
  const clientBeta = headers.get("anthropic-beta") ?? "-";
  const rawSystemType = typeof body.system;
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const roles = msgs
    .map((m) => (m && typeof m === "object" ? String((m as Record<string, unknown>).role ?? "?")[0] : "?"))
    .join("");

  // system 规范成块数组，给最后一块挂 1h 断点
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

  // 1h 必须带 beta，否则被当成默认 5m
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
    `sysType=${rawSystemType}`,
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
    console.log(`${head} | FETCH-ERR ${e instanceof Error ? e.message : e}`);
    return new Response('{"error":"upstream unreachable"}', { status: 502 });
  }

  const out = new Headers(res.headers);
  out.delete("content-encoding");
  out.delete("content-length");

  if (!LOG || !res.ok || !res.body) {
    console.log(`${head} | status=${res.status} usage=unread`);
    return new Response(res.body, { status: res.status, headers: out });
  }

  // tee：一路原样给客户端（流式不受影响），一路只用来读 usage
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
      console.log(`${head} | ${tail}`);
    } catch (e) {
      console.log(`${head} | usage-err ${e instanceof Error ? e.message : e}`);
    }
  })();

  return new Response(toClient, { status: res.status, headers: out });
});