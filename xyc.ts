// xyc 1h 缓存注入代理 · 最终诊断版
// Zeabur / Deno Deploy 通用，不需要设置任何环境变量
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

// 保存上一次请求的内容，用来对比出到底哪里变了
let prevSys = "";
let prevTools = "";

function record(line: string) {
  LINES.push(line);
  if (LINES.length > 300) LINES.shift();
  console.log(line);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v ?? null);
}

function hash(v: unknown): string {
  const s = str(v);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, "0") + "/" + s.length;
}

/** 把所有数字换成 0 再取哈希：如果这个稳定而原始哈希在变，就是时间戳之类在作怪 */
function hashNoDigit(s: string): string {
  return hash(s.replace(/\d/g, "0"));
}

/** 找出和上一次的第一处差异，把前后文打出来 */
function diff(prev: string, cur: string): string {
  if (prev === "") return "first";
  if (prev === cur) return "same";
  let i = 0;
  const min = Math.min(prev.length, cur.length);
  while (i < min && prev[i] === cur[i]) i++;
  const from = Math.max(0, i - 20);
  const a = prev.slice(from, i + 30).replace(/\s+/g, " ");
  const b = cur.slice(from, i + 30).replace(/\s+/g, " ");
  return `@${i} OLD<${a}> NEW<${b}>`;
}

/** 扫出请求里已有的所有缓存断点及其位置和 TTL */
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

function clock(): string {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(11, 19);
}

function textResponse(body: string): Response {
  return new Response(body, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

Deno.serve({ port: PORT }, async (req: Request) => {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/logs") {
    return textResponse(
      LINES.length === 0
        ? "暂无记录。若已聊过天，说明请求没到这个代理，检查 LobeHub 的 Base URL。"
        : LINES.join("\n\n"),
    );
  }

  if (path === "/logs/clear") {
    LINES.length = 0;
    prevSys = "";
    prevTools = "";
    return textResponse("已清空");
  }

  if (path === "/health") {
    return new Response(
      JSON.stringify({
        ok: true,
        ttl: TTL,
        lines: LINES.length,
        upstream: UPSTREAM,
      }),
      { headers: { "content-type": "application/json" } },
    );
  }

  const headers = new Headers(req.headers);
  for (const h of STRIP) headers.delete(h);

  const isMessages = req.method === "POST" &&
    (path === "/v1/messages" || path === "/messages");

  // 非 messages 的请求也记一笔，用来确认请求到底有没有到这里
  if (!isMessages) {
    record(`~ ${clock()} PASSTHRU ${req.method} ${path}`);
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

  // ===== 注入前先把原始状态全部记下来 =====
  const clientBeta = headers.get("anthropic-beta") ?? "-";
  const rawType = typeof body.system;
  const bpIn = scanBreakpoints(body);

  const sysStr = str(body.system);
  const toolsStr = str(body.tools);
  const sysDiff = diff(prevSys, sysStr);
  const toolsDiff = diff(prevTools, toolsStr);
  prevSys = sysStr;
  prevTools = toolsStr;

  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const roles = msgs
    .map((m) =>
      m && typeof m === "object"
        ? String((m as Record<string, unknown>).role ?? "?")[0]
        : "?"
    )
    .join("");

  // ===== 注入 1h 断点 =====
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
  const bpOut = scanBreakpoints(body);

  headers.set("content-type", "application/json");

  const head = [
    `#${id} ${clock()}`,
    `model=${body.model ?? "?"}`,
    `stream=${body.stream === true}`,
    `sysType=${rawType}`,
    `sys=${hash(body.system)}`,
    `sysND=${hashNoDigit(sysStr)}`,
    `tools=${hash(body.tools)}`,
    `toolsND=${hashNoDigit(toolsStr)}`,
    `msgs=${msgs.length}:${roles}`,
    `head2=${hash(msgs.slice(0, 2))}`,
    `tail1=${hash(msgs.slice(-1))}`,
    `bpIn=${bpIn}`,
    `bpOut=${bpOut}`,
    `apply=${apply}`,
    `betaIn=${clientBeta}`,
    `betaOut=${sentBeta}`,
  ].join(" ");

  const diffs = `  SYSDIFF ${sysDiff}\n  TOOLSDIFF ${toolsDiff}`;

  let res: Response;
  try {
    res = await fetch(UPSTREAM + path + url.search, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (e) {
    record(`${head}\n${diffs}\n  FETCH-ERR ${e instanceof Error ? e.message : e}`);
    return new Response('{"error":"upstream unreachable"}', { status: 502 });
  }

  const out = new Headers(res.headers);
  out.delete("content-encoding");
  out.delete("content-length");

  if (!res.ok || !res.body) {
    record(`${head}\n${diffs}\n  status=${res.status} usage=unread`);
    return new Response(res.body, { status: res.status, headers: out });
  }

  // tee：一路原样给客户端（流式不受影响），一路只读 usage
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
      record(`${head}\n${diffs}\n  ${tail}`);
    } catch (e) {
      record(`${head}\n${diffs}\n  usage-err ${e instanceof Error ? e.message : e}`);
    }
  })();

  return new Response(toClient, { status: res.status, headers: out });
});
