// xyc 1h 缓存注入代理 · 最终版
// Deno Deploy / Zeabur 通用，不需要设置任何环境变量
// 查看日志：https://你的域名/logs

const UPSTREAM = "https://apicdn.xycai.us";
const TTL = "1h";
const BETA = "extended-cache-ttl-2025-04-11";
const PORT = Number(Deno.env.get("PORT") ?? "8000");

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

/** 扫出请求里所有缓存断点的位置和 TTL */
function scanBreakpoints(body: Record<string, unknown>): string {
  const found: string[] = [];
  const ttlOf = (o: unknown): string | null => {
    if (!o || typeof o !== "object") return null;
    const cc = (o as Record<string, unknown>).cache_control;
    if (!cc || typeof cc !== "object") return null;
    return String((cc as Record<string, unknown>).ttl ?? "5m");
  };

  const sys = body.system;
  if (Array.isArray(sys)) {
    sys.forEach((b, i) => {
      const t = ttlOf(b);
      if (t) found.push(`sys${i}:${t}`);
    });
  }

  const tools = body.tools;
  if (Array.isArray(tools)) {
    tools.forEach((x, i) => {
      const t = ttlOf(x);
      if (t) found.push(`tool${i}:${t}`);
    });
  }

  const msgs = body.messages;
  if (Array.isArray(msgs)) {
    msgs.forEach((m, i) => {
      const c = m && typeof m === "object"
        ? (m as Record<string, unknown>).content
        : null;
      if (!Array.isArray(c)) return;
      c.forEach((b, j) => {
        const t = ttlOf(b);
        if (t) found.push(`msg${i}.${j}:${t}`);
      });
    });
  }

  return found.length === 0 ? "none" : `${found.length}[${found.join(",")}]`;
}

Deno.serve({ port: PORT }, async (req: Request) => {
  const url = new URL(req.url);
  const path = url.pathname;

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
  const bpIn = scanBreakpoints(body);
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const roles = msgs
    .map((m) =>
      m && typeof m === "object"
        ? String((m as Record<string, unknown>).role ?? "?")[0]
        : "?"
    )
    .join("");

  // ===== 第一步：把客户端已有的断点全部升成 1h =====
  // 必须全部升，不能只升一个。Anthropic 要求长 TTL 排在短 TTL 之前，
  // 混档（部分 1h 部分 5m）会导致整个请求按 5m 处理。
  let upgraded = 0;
  const upgrade = (o: unknown) => {
    if (!o || typeof o !== "object") return;
    const obj = o as Record<string, unknown>;
    const cc = obj.cache_control;
    if (!cc || typeof cc !== "object") return;
    obj.cache_control = { type: "ephemeral", ttl: TTL };
    upgraded++;
  };

  if (Array.isArray(body.system)) body.system.forEach(upgrade);
  if (Array.isArray(body.tools)) body.tools.forEach(upgrade);
  for (const m of msgs) {
    const c = m && typeof m === "object"
      ? (m as Record<string, unknown>).content
      : null;
    if (Array.isArray(c)) c.forEach(upgrade);
  }

  // ===== 第二步：客户端一个断点都没发时，代理自己补一个 =====
  // 客户端已经发了就别再插，避免超过 4 个上限。
  let apply = upgraded > 0 ? `upgrade:${upgraded}` : "none";
  if (upgraded === 0) {
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
        apply = `new:sys${sys.length - 1}`;
      }
    }
  }

  // 1h TTL 必须声明 beta，否则被当成默认 5m
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
    `bpIn=${bpIn}`,
    `bpOut=${scanBreakpoints(body)}`,
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
