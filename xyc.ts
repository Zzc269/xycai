/**
 * xyc 涓浆绔� 路 1h 鎻愮ず璇嶇紦瀛樻敞鍏ヤ唬鐞嗭紙Deno Deploy Playground 鍗曟枃浠剁増锛�
 *
 * 涓婃父锛歨ttps://apicdn.xycai.us  锛堝湴鍧€涓嶅甫 /v1锛屽鎴风璺緞鍘熸牱杞彂锛�
 *
 * 鐢ㄦ硶锛氭柊寤轰竴涓� Playground锛屾妸杩欎釜鏂囦欢鏁翠綋绮樿创杩涘幓锛屼繚瀛樺嵆閮ㄧ讲銆�
 * LobeHub 鐨� Anthropic Base URL 濉� https://浣犵殑椤圭洰鍚�.deno.dev 锛堝悗闈笉瑕佸啀鍔� /v1锛�
 *
 * 鍙€夌幆澧冨彉閲忥紙Playground 鐨� Settings 閲屽姞锛屼笉璁句篃鑳借窇锛夛細
 *   UPSTREAM_URL      瑕嗙洊涓婃父鍦板潃
 *   PROXY_TOKEN       璁块棶浠ょ墝銆傝浜嗕箣鍚庤姹傚繀椤诲甫 x-proxy-token
 *   CACHE_TTL_ON      璁句负 "0" 涓存椂鍏抽棴娉ㄥ叆锛屼究浜� A/B 瀵规瘮鎴愭湰
 *   TAIL_BREAKPOINTS  浼氳瘽灏鹃儴鏂偣鏁帮紝榛樿 2
 *   MIN_CACHE_TOKENS  寤虹紦瀛樼殑鏈€灏忓墠缂€ token 鏁帮紝榛樿 1200锛圚aiku 妗ｉ渶璁� 2048锛�
 *   DEBUG             璁句负 "1" 鎵撳嵃鏂偣钀界偣銆乥eta 澶淬€佷互鍙� system 鎸囩汗
 */

// ==================== 鍙湁杩欎竴娈典笌 passion8 鐗堟湰涓嶅悓 ====================

const PROVIDER = "xyc";
const DEFAULT_UPSTREAM = "https://apicdn.xycai.us";
/** 涓婃父鍦板潃鏄惁宸茬粡鍖呭惈 /v1 鍓嶇紑銆倄yc 涓嶅惈锛屾墍浠ユ槸 false銆� */
const UPSTREAM_HAS_V1 = false;

// ======================================================================

const TTL = "1h";

/** Anthropic 鍗曡姹傛渶澶� 4 涓� cache 鏂偣銆� */
const MAX_BREAKPOINTS = 4;

/**
 * 浣庝簬杩欎釜 token 鏁板氨涓嶆彃鏂偣锛欰nthropic 瀵瑰皬浜庢渶灏� token 鏁扮殑鍓嶇紑鐩存帴鎷掔粷缂撳瓨锛�
 * 鐧藉崰涓€涓柇鐐归搴︺€係onnet/Opus 涓嬮檺 1024锛孒aiku 涓嬮檺 2048銆�
 */
const MIN_TOKENS = Number(Deno.env.get("MIN_CACHE_TOKENS") ?? "1200");

/** 1h TTL 蹇呴』澹版槑鐨� beta 鐗规€у悕銆� */
const BETA_FLAG = "extended-cache-ttl-2025-04-11";

/** 鎺ュ彈 cache_control 鐨勫潡绫诲瀷锛泃hinking 鍧椾笉鎺ュ彈銆� */
const CACHEABLE_TYPES = new Set([
  "text",
  "image",
  "document",
  "tool_use",
  "tool_result",
  "search_result",
]);

// deno-lint-ignore no-explicit-any
type Any = any;

function isObj(v: unknown): v is Record<string, Any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function cc() {
  return { type: "ephemeral", ttl: TTL };
}

/**
 * 绮楃暐浼扮畻 token 鏁般€侰JK 涓€瀛楃害涓€ token锛屽叾浣欐寜鍥涘瓧绗︿竴 token銆�
 * 鍙敤浜庡拰鏈€灏忕紦瀛橀暱搴︽瘮杈冿紝涓嶉渶瑕佺簿纭€�
 */
function approxTokens(v: unknown): number {
  let cjk = 0;
  let other = 0;
  const walk = (x: unknown) => {
    if (typeof x === "string") {
      for (const ch of x) {
        const c = ch.codePointAt(0)!;
        if (c > 0x2e80) cjk++;
        else other++;
      }
    } else if (Array.isArray(x)) {
      for (const y of x) walk(y);
    } else if (isObj(x)) {
      for (const y of Object.values(x)) walk(y);
    }
  };
  walk(v);
  return cjk + Math.ceil(other / 4);
}

/** 鏁翠釜璇锋眰浣撶殑鍙紦瀛樺唴瀹逛綋閲忥紝鐢ㄤ簬銆屽お灏忓氨鏁翠綋璺宠繃銆嶇殑蹇€熷垽鏂€� */
function totalTokens(body: Any): number {
  return approxTokens(body?.system) + approxTokens(body?.tools) +
    approxTokens(body?.messages);
}

/** 鏀堕泦宸插瓨鍦ㄧ殑 cache_control 瀹夸富瀵硅薄銆� */
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

/** 瀛楃涓插唴瀹硅鑼冩垚鍧楁暟缁勶紝渚夸簬鎸傛柇鐐广€� */
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
    const t = blocks[i].type;
    if (typeof t === "string" && CACHEABLE_TYPES.has(t)) return blocks[i];
  }
  return null;
}

interface InjectResult {
  changed: boolean;
  /** 鏂偣钀界偣璇存槑锛岀敤浜庢棩蹇椼€� */
  applied: string[];
  skipped?: string;
}

/**
 * 鍘熷湴娉ㄥ叆 Anthropic /v1/messages 鏂偣銆�
 * 椤哄簭鎸夊墠缂€绋冲畾搴︼細tools -> system -> 浼氳瘽灏鹃儴銆�
 */
function injectAnthropic(body: Any, tailBreakpoints = 2): InjectResult {
  const applied: string[] = [];
  let changed = false;

  // 瀹㈡埛绔凡甯︾殑鏂偣锛氭敼鍐欐垚 1h锛岃€屼笉鏄彟寮€涓€涓柇鐐规氮璐归搴︺€�
  const holders = existingHolders(body);
  for (const h of holders) {
    if (h.cache_control.ttl !== TTL) {
      h.cache_control = { ...h.cache_control, type: "ephemeral", ttl: TTL };
      changed = true;
    }
  }
  if (holders.length > 0) applied.push(`upgraded:${holders.length}`);

  const total = totalTokens(body);
  if (total < MIN_TOKENS) {
    return { changed, applied, skipped: `too-small:${total}<${MIN_TOKENS}tok` };
  }

  let budget = MAX_BREAKPOINTS - holders.length;
  if (budget <= 0) return { changed, applied, skipped: "no-budget" };

  const mark = (h: Record<string, Any>, label: string) => {
    h.cache_control = cc();
    applied.push(label);
    budget--;
    changed = true;
  };

  // 缂撳瓨鍓嶇紑鏄€屾柇鐐逛箣鍓嶇殑绱鍐呭銆嶏紝鏂偣涔嬪悗鐨勫唴瀹瑰啀澶氫篃涓嶇畻銆�
  // 鎵€浠ユ瘡涓€欓€変綅缃兘瑕佹寜瀹冭嚜宸辩殑鍓嶇紑闀垮害鍒ゆ柇锛屼笉鑳界敤璇锋眰浣撴€婚噺銆�
  const toolsTok = approxTokens(body?.tools);
  const systemTok = approxTokens(body?.system);

  if (budget > 0 && Array.isArray(body.tools) && body.tools.length > 0) {
    const last = body.tools.filter(isObj).at(-1);
    if (last && !isObj(last.cache_control)) {
      if (toolsTok >= MIN_TOKENS) mark(last, "tools");
      else applied.push(`skip-tools:${toolsTok}tok`);
    }
  }

  if (budget > 0 && body.system !== undefined) {
    const blocks = toBlocks(body.system);
    const target = blocks && lastCacheable(blocks);
    if (blocks && target && !isObj(target.cache_control)) {
      const prefix = toolsTok + systemTok;
      if (prefix >= MIN_TOKENS) {
        body.system = blocks;
        mark(target, "system");
      } else {
        applied.push(`skip-system:${prefix}tok`);
      }
    }
  }

  if (budget > 0 && tailBreakpoints > 0 && Array.isArray(body.messages)) {
    // 绗� i 鏉℃秷鎭笂鐨勬柇鐐癸紝鍏跺墠缂€鏄� tools + system + messages[0..i]銆�
    const msgs = body.messages as Any[];
    const cum: number[] = [];
    let run = toolsTok + systemTok;
    for (const m of msgs) {
      run += approxTokens(m);
      cum.push(run);
    }

    let placed = 0;
    for (
      let i = msgs.length - 1;
      i >= 0 && placed < tailBreakpoints && budget > 0;
      i--
    ) {
      // 寰€鍓嶈蛋鍓嶇紑鍙細鏇寸煭锛岃繖閲屼笉澶熼暱灏辨病蹇呰缁х画浜嗐€�
      if (cum[i] < MIN_TOKENS) {
        applied.push(`skip-msgs:${cum[i]}tok`);
        break;
      }
      const msg = msgs[i];
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

/**
 * OpenAI 鍏煎閫氶亾锛�/v1/chat/completions锛夈€�
 * 涓浆绔欏璇ヨ矾寰勭殑 cache_control 鏀寔涓嶄竴鑷达紝杩欓噷鍙仛淇濆畧澶勭悊锛�
 * 缁� system 娑堟伅鎸傛柇鐐癸紝骞惰ˉ榻愬凡鏈夋柇鐐圭殑 ttl銆�
 */
function injectOpenAI(body: Any): InjectResult {
  const applied: string[] = [];
  let changed = false;

  const holders = existingHolders(body);
  for (const h of holders) {
    if (h.cache_control.ttl !== TTL) {
      h.cache_control = { ...h.cache_control, type: "ephemeral", ttl: TTL };
      changed = true;
    }
  }
  if (holders.length > 0) applied.push(`upgraded:${holders.length}`);

  const total = totalTokens(body);
  if (total < MIN_TOKENS) {
    return { changed, applied, skipped: `too-small:${total}<${MIN_TOKENS}tok` };
  }
  if (!Array.isArray(body.messages)) return { changed, applied, skipped: "no-messages" };

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
      applied.push("system-msg");
      changed = true;
    }
  }

  return { changed, applied };
}

/** 璇锋眰浣撻噷鏄惁鐪熺殑瀛樺湪 ttl=1h 鐨勬柇鐐广€俠eta 澶磋鎸夎繖涓垽鏂紝鑰屼笉鏄湅鏈夋病鏈夋敼鍐欒繃銆� */
function hasOneHourCache(body: Any): boolean {
  let found = false;
  const walk = (v: unknown) => {
    if (found) return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (!isObj(v)) return;
    if (isObj(v.cache_control) && v.cache_control.ttl === TTL) {
      found = true;
      return;
    }
    for (const x of Object.values(v)) walk(x);
  };
  walk(body?.system);
  walk(body?.messages);
  walk(body?.tools);
  return found;
}

/**
 * 缁� system 鍙栨寚绾广€傚墠缂€姣忚疆鍙樺寲锛堟敞鍏ユ椂闂存埑銆佷細璇濇爣棰樼瓑锛変細璁╃紦瀛樻案杩滀笉鍛戒腑锛�
 * 杩欎釜鎸囩汗鐢ㄦ潵鎶娿€屽墠缂€婕傜Щ銆嶅拰銆屾柇鐐规病鎵撲笂銆嶄袱绉嶆儏鍐靛尯鍒嗗紑銆�
 */
function systemFingerprint(body: Any): string {
  const s = typeof body?.system === "string"
    ? body.system
    : JSON.stringify(body?.system ?? null);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  const hash = (h >>> 0).toString(16).padStart(8, "0");
  return `len=${s.length} hash=${hash} head=${JSON.stringify(s.slice(0, 160))}`;
}

/** 淇濈暀瀹㈡埛绔凡鏈夌殑 beta 鐗规€э紝杩藉姞 1h TTL 鎵€闇€鐨勯偅涓€涓紝涓嶉噸澶嶃€� */
function mergeBetaHeader(current: string | null): string {
  const parts = (current ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (!parts.includes(BETA_FLAG)) parts.push(BETA_FLAG);
  return parts.join(",");
}

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers":
    "content-type, x-proxy-token, authorization, x-api-key, anthropic-version, anthropic-beta, anthropic-dangerous-direct-browser-access",
  "access-control-max-age": "86400",
};

/** 涓嶈兘鍘熸牱杞彂缁欎笂娓哥殑閫愯烦澶�/闀垮害澶淬€� */
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
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
];

const UPSTREAM = (Deno.env.get("UPSTREAM_URL") || DEFAULT_UPSTREAM).replace(/\/+$/, "");
const PROXY_TOKEN = Deno.env.get("PROXY_TOKEN") || "";
const ENABLED = Deno.env.get("CACHE_TTL_ON") !== "0";
const TAIL = Number(Deno.env.get("TAIL_BREAKPOINTS") ?? "2");
const DEBUG = Deno.env.get("DEBUG") === "1";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "content-type": "application/json" },
  });
}

/** 鎭掑畾鏃堕棿姣旇緝锛岄伩鍏嶄护鐗岃閫愬瓧绗﹁瘯鎺€€� */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 鍘绘帀鏈熬鏂滄潬锛涙牴璺緞褰掍竴涓� "/"銆� */
function normalizePath(pathname: string): string {
  return pathname.replace(/\/+$/, "") || "/";
}

function isMessagesPath(path: string): boolean {
  return path === "/v1/messages" || path === "/messages";
}

function isChatPath(path: string): boolean {
  return path === "/v1/chat/completions" || path === "/chat/completions";
}

/**
 * 鎷兼帴涓婃父 URL銆備笂娓稿湴鍧€鑷甫 /v1 涓斿鎴风涔熷彂浜� /v1 鏃跺幓鎺変竴灞傦紝
 * 閬垮厤鍑虹幇 /v1/v1/messages銆�
 */
function resolveUpstream(path: string): string {
  if (!UPSTREAM_HAS_V1) return UPSTREAM + path;
  return UPSTREAM + (path.startsWith("/v1/") ? path.slice(3) : path);
}

async function forward(
  method: string,
  target: string,
  headers: Headers,
  body: BodyInit | null,
  path: string,
  note: string,
): Promise<Response> {
  try {
    const upstream = await fetch(target, {
      method,
      headers,
      body,
      // 閫忎紶鍘熷璇锋眰浣撴祦鏃跺繀椤诲０鏄� duplex銆�
      ...(body !== null && typeof body === "object" ? { duplex: "half" } : {}),
    } as RequestInit);

    if (DEBUG) {
      console.log(`[${PROVIDER}] ${method} ${path} -> ${upstream.status} | ttl=${TTL} | ${note}`);
    }

    // 淇濈暀涓婃父鍝嶅簲澶达紝鍘绘帀浼氱牬鍧忔祦寮忎紶杈撳拰宸茶В鐮佸唴瀹圭殑閭ｅ嚑涓€�
    const out = new Headers(upstream.headers);
    out.delete("content-encoding");
    out.delete("content-length");
    out.delete("transfer-encoding");
    out.delete("connection");
    for (const [k, v] of Object.entries(CORS_HEADERS)) out.set(k, v);

    return new Response(upstream.body, { status: upstream.status, headers: out });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[${PROVIDER}] upstream error on ${path}: ${message}`);
    return json({ error: `upstream error: ${message}` }, 502);
  }
}

export async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = normalizePath(url.pathname);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method === "GET" && (path === "/health" || path === "/")) {
    return json({
      ok: true,
      provider: PROVIDER,
      upstream: UPSTREAM,
      upstreamHasV1: UPSTREAM_HAS_V1,
      ttl: TTL,
      injection: ENABLED ? "on" : "off",
      tailBreakpoints: TAIL,
      minCacheTokens: MIN_TOKENS,
    });
  }

  if (PROXY_TOKEN) {
    const supplied = req.headers.get("x-proxy-token") || "";
    if (!safeEqual(supplied, PROXY_TOKEN)) return json({ error: "unauthorized" }, 401);
  }

  const target = resolveUpstream(path) + url.search;
  const headers = new Headers(req.headers);
  for (const h of STRIP_HEADERS) headers.delete(h);

  // 闈� JSON 璇锋眰浣撶殑璺緞锛堝 /v1/models锛夊師鏍烽€忎紶锛屼笉瑙ｆ瀽涓嶆敼鍐欍€�
  const cacheable = req.method === "POST" && (isMessagesPath(path) || isChatPath(path));
  if (!cacheable) {
    return await forward(req.method, target, headers, req.body, path, "passthrough");
  }

  let body: unknown;
  try {
    body = JSON.parse(await req.text());
  } catch {
    return json({ error: "bad json body" }, 400);
  }

  // 娉ㄥ叆鍓嶅厛璁版寚绾癸細鍛戒腑澶辫触鏃剁敤鏉ュ垽鏂槸涓嶆槸鍓嶇紑姣忚疆閮藉湪鍙樸€�
  if (DEBUG && isMessagesPath(path)) {
    console.log(`[${PROVIDER}] system ${systemFingerprint(body)}`);
  }

  let note = "off";
  if (ENABLED) {
    const result = isMessagesPath(path) ? injectAnthropic(body, TAIL) : injectOpenAI(body);
    note = result.skipped ? `skipped(${result.skipped})` : `applied[${result.applied.join(" ")}]`;
  }

  // 1h TTL 蹇呴』澹版槑 beta锛屽惁鍒� ttl 琚拷鐣ャ€佹寜榛樿 5 鍒嗛挓璁¤垂銆�
  // 鍒ゆ柇渚濇嵁鏄姹備綋閲屾湁娌℃湁 1h 鏂偣锛岃€屼笉鏄湰浠ｇ悊鏈夋病鏈夋敼鍐欒繃锛�
  // 瀹㈡埛绔嚜宸卞凡缁忔爣濂� 1h 鏃舵敞鍏ョ粨鏋滄槸銆屾棤鏀瑰姩銆嶏紝閭ｆ椂鍚屾牱闇€瑕佽繖涓ご銆�
  if (isMessagesPath(path)) {
    if (hasOneHourCache(body)) {
      headers.set("anthropic-beta", mergeBetaHeader(headers.get("anthropic-beta")));
      note += ` beta[${headers.get("anthropic-beta")}]`;
    } else {
      note += " beta[none]";
    }
  }

  headers.set("content-type", "application/json");
  return await forward("POST", target, headers, JSON.stringify(body), path, note);
}

export default { fetch: handler };

Deno.serve(handler);
