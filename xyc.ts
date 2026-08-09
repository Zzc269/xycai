// xyc 缓存注入代理 · 可切档 + 原始响应诊断
// 环境变量 MODE：off（默认，不注入）| sys（只升 system）| all（全升 1h）

const UPSTREAM = "https://apicdn.xycai.us";
const TTL = "1h";
const BETA = "extended-cache-ttl-2025-04-11";
const PORT = Number(Deno.env.get("PORT") ?? "8000");
const MODE = Deno.env.get("MODE") ?? "off";

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
    return new Response(
      LINES.length === 0 ? "暂无记录。" : LINES.join("\n\n"),
      { headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }

  if (path === "/logs/clear") {
    LINES.length = 0;
    return new Response("已清空", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  if (path === "/health") {
    return new Response(
      JSON.stringify({ ok: true, mode: MODE, ttl: TTL, lines: LINES.length }),
      { headers: { "content-type": "application/json" } },
    );
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
  const bpIn = scanBreakpoints(body);
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const roles = msgs
    .map((m) =>
      m && typeof m === "object"
        ? String((m as Record<string, unknown>).role ?? "?")[0]
        : "?"
    )
    .join("");

  let apply = "off";
  const toOneHour = (o: unknown) => {
    if (!o || typeof o !== "object") return false;
    const obj = o as Record<string, unknown>;
    const cc = obj.cache_control;
    if (!cc || typeof cc !== "object") return false;
    obj.cache_control = { type: "ephemeral", ttl: TTL };
    return true;
  };

  if (MODE === "sys") {
    // 只升 system 里的断点，tools 和 messages 保持原样
    let n = 0;
    if (Array.isArray(body.system)) {
      for (const b of body.system) if (toOneHour(b)) n++;
    }
    apply = `sys:${n}`;
  } else if (MODE === "all") {
    // 全部升成 1h
    let n = 0;
    if (Array.isArray(body.system)) {
      for (const b of body.system) if (toOneHour(b)) n++;
    }
    if (Array.isArray(body.tools)) {
      for (const x of body.tools) if (toOneHour(x)) n++;
    }
    for (const m of msgs) {
      const c = m && typeof m === "object"
        ? (m as Record<string, unknown>).content
        : null;
      if (Array.isArray(c)) for (const b of c) if (toOneHour(b)) n++;
    }
    apply = `all:${n}`;
  }

  if (MODE !== "off") {
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
    `MODE=${MODE}`,
    `model=${body.model ?? "?"}`,
    `sys=${hash(body.system)}`,
    `tools=${hash(body.tools)}`,
    `msgs=${msgs.length}:${roles}`,
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
    record(`${head}\n  FETCH-ERR ${e instanceof Error ? e.message : e}`);
    return new Response('{"error":"upstream unreachable"}', { status: 502 });
  }

  const out = new Headers(res.headers);
  out.delete("content-encoding");
  out.delete("content-length");

  if (!res.body) {
    record(`${head}\n  status=${res.status} NO-BODY ct=${res.headers.get("content-type")}`);
    return new Response(null, { status: res.status, headers: out });
  }

  const [toClient, toLog] = res.body.tee();
  (async () => {
    try {
      const text = await new Response(toLog).text();
      const pick = (k: string) => {
        const m = new RegExp('"' + k + '"\\s*:\\s*(\\d+)').exec(text);
        return m ? m[1] : "-";
      };
      const usage = [
        `status=${res.status}`,
        `len=${text.length}`,
        `read=${pick("cache_read_input_tokens")}`,
        `w1h=${pick("ephemeral_1h_input_tokens")}`,
        `w5m=${pick("ephemeral_5m_input_tokens")}`,
        `in=${pick("input_tokens")}`,
        `out=${pick("output_tokens")}`,
      ].join(" ");
      // 没解析到 usage 时，把上游原样返回的前 400 字打出来
      const raw = pick("input_tokens") === "-"
        ? `\n  RAW ct=${res.headers.get("content-type")} <${text.slice(0, 400).replace(/\s+/g, " ")}>`
        : "";
      record(`${head}\n  ${usage}${raw}`);
    } catch (e) {
      record(`${head}\n  usage-err ${e instanceof Error ? e.message : e}`);
    }
  })();

  return new Response(toClient, { status: res.status, headers: out });
});
