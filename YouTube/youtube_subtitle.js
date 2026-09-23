/*
 * YouTube App 双语字幕（Surge http-response 脚本）
 * - 拦截 www/m.youtube.com/api/timedtext 的字幕响应，逐行调用翻译接口
 *   （DeepSeek / OpenAI / 谷歌翻译三选一），按原格式回写成双语字幕
 *   谷歌翻译使用免费端点、无需 API Key；目标语言使用语言代码，可由 BoxJS 的
 *   target_code 覆盖，留空时按目标语言名自动匹配
 * - srv3(ttml/xml)：每个 <p> cue 内以字面换行追加译文行（与官方多行 cue 的
 *   字节形态一致；对 XML 解析器而言与 &#x000A; 实体等价）
 *   json3：每个 event 的 segs 合并为一段 utf8，以 \n 追加译文行
 * - 自动字幕（kind=asr）：跳过 a="1" 追加 cue，清除滚动窗口属性，并把重叠
 *   的 cue 时长收到下一条起点，让滚动字幕退化为不堆叠的静态双语 cue
 * - 参数全部在 BoxJS《YouTube AI双语字幕》中调整：
 *   服务商 / API Key / Base URL / 模型 / 目标语言 / 双语位置 / 翻译缓存
 * - BoxJS 可调整 mode 四档诊断开关与 budget_ms；日志前缀为 [yt-sub]
 * - App 内手动选择"自动翻译"语言的请求（URL 带 tlang）原样放行；
 *   DeepSeek/OpenAI 未配置 API Key、格式不识别或翻译失败时同样原样返回，不影响原始字幕
 * - 缓存按行存"译文字典"（key=服务商|模型|源语言|目标语言），与字幕格式/双语位置
 *   无关，跨视频复用；未翻出的行下次请求自动续翻，逐步收敛到完整双语
 */

const PROVIDERS = {
  deepseek: { kind: "openai", base: "https://api.deepseek.com", model: "deepseek-chat" },
  openai: { kind: "openai", base: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  google: { kind: "google", base: "https://translate.googleapis.com/translate_a/t", model: "gtx" },
};

const CHUNK_LINES = 20; // 每次请求翻译的行数（小批次才能在预算内翻完）
const CONCURRENCY = 3; // 并发翻译请求数
const API_TIMEOUT = 15; // 单次 LLM 请求超时（秒）
// 全局翻译时限。瓶颈不是模块 timeout=120，而是 YouTube App 自己的请求超时：
// 等不到响应它直接显示"加载字幕出错"。宁可本轮只翻一部分——翻出的行进缓存，
// 剩下的下次开字幕自动续翻，逐步收敛到完整双语。可被 BoxJS 的
// youtube_subtitle.budget_ms 覆盖
const BUDGET_MS = 20 * 1000;
const CACHE_KEY = "youtube_subtitle.cache.data";
const CACHE_MAX = 6; // 缓存的 服务商|模型|目标语言 组合数（LRU）
const DICT_MAX = 3000; // 每组译文字典的最大行数
const CACHE_MAX_BYTES = 400 * 1024; // 持久化体积上限

const readKey = (n, dft) => {
  const v = $persistentStore.read(`youtube_subtitle.${n}`);
  return v === undefined || v === null || v === "" ? dft : v;
};

// mode: on 正常双语；passthrough 完整翻译后回原始 body；headers 仅清洗响应头；off 完全不处理
const cfg = {
  provider: readKey("provider", "deepseek"),
  mode: readKey("mode", "on"),
  budgetMs: Math.max(3000, parseInt(readKey("budget_ms", "20000"), 10) || 20000),
  apiKey: readKey("api_key", ""),
  baseUrl: readKey("base_url", ""),
  model: readKey("model", ""),
  targetLang: readKey("target_lang", "简体中文"),
  targetCode: readKey("target_code", ""),
  position: readKey("position", "below"), // below=原上译下 above=译上原下 only=仅译文
  cache: String(readKey("cache", "true")) !== "false",
};

const LANG_CODES = {
  简体中文: "zh-CN", 中文: "zh-CN", 繁体中文: "zh-TW", 繁體中文: "zh-TW",
  英语: "en", 英文: "en", 日语: "ja", 日文: "ja", 韩语: "ko", 韩文: "ko",
  法语: "fr", 德语: "de", 西班牙语: "es", 俄语: "ru",
};
// 用户显式填了代码就用它；否则按目标语言名查表；都没有就退回 zh-CN
const targetCode = cfg.targetCode || LANG_CODES[cfg.targetLang] || "zh-CN";

const provider = PROVIDERS[cfg.provider] || PROVIDERS.deepseek;
const isGoogle = provider.kind === "google";
// 谷歌是查表式翻译、无 token 生成，单次更快也能吃更大批次
const chunkLines = isGoogle ? 80 : CHUNK_LINES;
const apiTimeout = isGoogle ? 8 : API_TIMEOUT;
const baseEp = (cfg.baseUrl || provider.base).replace(/\/+$/, "");
// base_url 已带 /chat/completions 时不再重复拼接
const endpoint = isGoogle
  ? cfg.baseUrl || provider.base
  : /\/chat\/completions$/.test(baseEp)
    ? baseEp
    : `${baseEp}/chat/completions`;
const model = cfg.model || provider.model;

const T0 = Date.now();
const ms = () => Date.now() - T0;
const log = (m) => console.log(`[yt-sub] ${m}`);
if (/^http:\/\//i.test(endpoint)) log("WARN: http:// 端点，API Key 将明文传输");

const getParam = (url, name) => {
  const m = url.match(new RegExp(`[?&]${name}=([^&]*)`));
  return m ? decodeURIComponent(m[1].replace(/\+/g, " ")) : null;
};

const xmlDecode = (s) =>
  s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&amp;/g, "&");

const xmlEscape = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// a="1" 是自动字幕的追加/换行辅助 cue。实测样本里它们都是空的（已被
// !text.trim() 挡掉）；带文字的 a="1" 行为未确证，保守起见原样放行——
// 宁可这行没有译文，也不要把译文接在半句话中间
const isAppendCue = (attrs) => /\ba="1"/.test(attrs);

// XML 侧对应 JSON 的 delete ev.wWinId：去掉滚动窗口引用（w）、追加标记（a）
// 与指向滚动样式/位置的 ws/wp，让 cue 退化为静态显示；t/d 等时序属性保留
const staticAttrs = (attrs) =>
  attrs
    .replace(/\s+ws="[^"]*"/g, "")
    .replace(/\s+wp="[^"]*"/g, "")
    .replace(/\s+w="[^"]*"/g, "")
    .replace(/\s+a="[^"]*"/g, "");

const attrNum = (attrs, name) => {
  const m = attrs.match(new RegExp(`\\b${name}="(-?\\d+)"`));
  return m ? parseInt(m[1], 10) : null;
};

// 自动字幕靠滚动窗口同屏显示多行，相邻 cue 的时间区间大幅重叠。去掉窗口属性
// 后它们变成静态 cue，重叠就会堆在屏幕上，所以把时长收到下一条有文字的 cue
// 起点。只缩不放：普通字幕本就不重叠，这里是空操作
const clampDur = (attrs, t, d, nextT) => {
  if (t == null || d == null || nextT == null || t + d <= nextT) return attrs;
  return attrs.replace(/\bd="[^"]*"/, `d="${Math.max(1, nextT - t)}"`);
};

// 按 position 拼接原文与译文；无译文时回退原文
const compose = (orig, trans, br) => {
  if (!trans) return orig;
  if (cfg.position === "only") return trans;
  return cfg.position === "above"
    ? `${trans}${br}${orig}`
    : `${orig}${br}${trans}`;
};

// Surge 交给脚本的是已解压的 body，而原始响应头里的 Content-Length 仍是
// 原文长度、Content-Encoding 仍写着 gzip/br。双语回写后 body 变长，沿用旧头
// 会让 App 按旧长度截断读取、或把明文当压缩数据解 -- 表现就是"加载字幕出错"。
// 这两个头必须去掉，交给 Surge 重新计算
const cleanHeaders = () => {
  const h = (typeof $response !== "undefined" && $response && $response.headers) || null;
  if (!h) return null;
  const out = {};
  for (const k of Object.keys(h)) {
    const lk = k.toLowerCase();
    if (lk === "content-length" || lk === "content-encoding") continue;
    out[k] = h[k];
  }
  return out;
};

// 解析字幕正文，返回 {format, items:[{text}], rebuild(map)}
// items[].text 为 cue 全文；rebuild 用 map(原文→译文) 重建整个响应体
const parseSubtitles = (format, body) => {
  if (format === "json") {
    const obj = JSON.parse(body);
    if (!obj || !Array.isArray(obj.events)) return null;
    const items = [];
    for (const ev of obj.events) {
      if (!ev || !Array.isArray(ev.segs)) continue;
      const text = ev.segs.map((s) => (s && s.utf8) || "").join("");
      if (text.trim()) items.push({ ev, text });
    }
    for (let i = 0; i < items.length; i++) {
      const nx = items[i + 1];
      items[i].nextT = nx && typeof nx.ev.tStartMs === "number" ? nx.ev.tStartMs : null;
    }
    return {
      format,
      items,
      rebuild(map) {
        for (const it of items) {
          const t = map.get(it.text);
          if (t == null) continue; // 未翻出的 cue 保留原始结构（含 karaoke 时序）
          it.ev.segs = [{ utf8: compose(it.text, t, "\n") }];
          // 清除 event 对滚动窗口/样式/位置的引用（顶层的 wpWinPositions、
          // wsWinStyles 是定义表，不能动），让滚动 cue 退化为静态 cue
          delete it.ev.wWinId;
          delete it.ev.wpWinPosId;
          delete it.ev.wsWinStyleId;
          const nt = it.nextT;
          if (
            typeof it.ev.tStartMs === "number" &&
            typeof it.ev.dDurationMs === "number" &&
            typeof nt === "number" &&
            it.ev.tStartMs + it.ev.dDurationMs > nt
          ) {
            it.ev.dDurationMs = Math.max(1, nt - it.ev.tStartMs);
          }
        }
        return JSON.stringify(obj);
      },
    };
  }

  // xml / srv3 / ttml：逐 <p> cue 处理；空 cue 记 skip 保持与正则匹配一一对应
  const re = /<p\b[^>]*>[\s\S]*?<\/p>/g;
  const items = [];
  let m;
  while ((m = re.exec(body)) !== null) {
    const full = m[0];
    const openEnd = full.indexOf(">");
    const attrs = full.slice(2, openEnd); // 含前导空格，原样保留
    const inner = full.slice(openEnd + 1, -4);
    const text = xmlDecode(inner.replace(/<[^>]+>/g, ""));
    items.push({
      attrs,
      text,
      skip: !text.trim() || isAppendCue(attrs),
      t: attrNum(attrs, "t"),
      d: attrNum(attrs, "d"),
    });
  }
  if (!items.some((i) => !i.skip)) return null;
  for (let i = items.length - 1, nextT = null; i >= 0; i--) {
    items[i].nextT = nextT;
    if (!items[i].skip) nextT = items[i].t;
  }
  return {
    format,
    items,
    rebuild(map) {
      let out = "";
      let last = 0;
      let k = 0;
      re.lastIndex = 0;
      while ((m = re.exec(body)) !== null) {
        out += body.slice(last, m.index);
        const it = items[k++];
        const t = it.skip ? undefined : map.get(it.text);
        if (t == null) {
          out += m[0]; // 空 cue 与未翻出的 cue 原样输出，保留 <s> 结构
        } else {
          const orig = xmlEscape(it.text);
          // \n 是合法 XML 字面字符且 xmlEscape 不改它；各自转义后用字面换行
          // 拼接，与官方 srv3 多行 cue（<p> 内裸文本 + 真换行）形态一致
          const inner =
            cfg.position === "only"
              ? xmlEscape(t)
              : cfg.position === "above"
                ? `${xmlEscape(t)}\n${orig}`
                : `${orig}\n${xmlEscape(t)}`;
          const attrsOut = clampDur(
            staticAttrs(it.attrs),
            it.t,
            it.d,
            it.nextT
          );
          out += `<p${attrsOut}>${inner}</p>`;
        }
        last = m.index + m[0].length;
      }
      out += body.slice(last);
      return out;
    },
  };
};

const detectFormat = (url, body) => {
  const fmt = (getParam(url, "fmt") || "").toLowerCase();
  if (["vtt", "webvtt", "txt", "raw"].includes(fmt)) return null; // 不处理的格式
  if (fmt === "json3" || fmt === "json") return "json";
  const head = body.slice(0, 64).trim();
  if (head.startsWith("{")) return "json";
  if (head.startsWith("<")) return "xml";
  return null;
};

const httpPost = (req, timeout) =>
  new Promise((resolve) => {
    let settled = false;
    const done_ = (r) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    // JS 级兜底定时：万一 Surge 的 timeout 选项对不回调的挂起连接失效，
    // promise 也必然返回，脚本不会拖到模块超时被强杀（真机表现为字幕加载失败）。
    // 留 1.5s 余量，否则本定时器总比 $httpClient 自己的超时回调先触发，等于
    // 把 Surge 的超时处理整个架空
    const timer =
      typeof setTimeout === "function"
        ? setTimeout(() => done_({ err: "timeout" }), timeout * 1000 + 1500)
        : null;
    try {
      $httpClient.post(
        {
          url: req.url,
          timeout,
          headers: req.headers,
          body: req.body,
        },
        (err, resp, data) => {
          if (timer !== null) clearTimeout(timer);
          done_({ err, status: resp && resp.status, data });
        }
      );
    } catch (e) {
      if (timer !== null) clearTimeout(timer);
      done_({ err: String(e) });
    }
  });

const buildOpenAIReq = (lines) => ({
  url: endpoint,
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
  body: JSON.stringify({
    model,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content:
          `You are a subtitle translation engine. Translate each input line into ${cfg.targetLang}. ` +
          `Return ONLY a JSON object {"translations":[...]} with exactly ${lines.length} items in the same order. ` +
          `Use natural, concise spoken-subtitle style; never merge, split, or omit lines; ` +
          `preserve "\\n" inside a line; translate meaning rather than word-for-word.`,
      },
      { role: "user", content: JSON.stringify(lines) },
    ],
  }),
});

// translate_a/t 接收多个 q，返回与输入等长、顺序一致的字符串数组。
// 源语言用字幕轨道自带的 lang，取不到时交给 auto
const buildGoogleReq = (lines, srcLang) => {
  const qs = lines.map((l) => `q=${encodeURIComponent(l)}`).join("&");
  const sl = srcLang || "auto";
  return {
    url: `${endpoint}?client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(targetCode)}`,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0",
    },
    body: qs,
  };
};

// 从模型输出中取出译文数组，容忍 markdown 围栏与 {translations:[...]}/裸数组两种形态
const extractTranslations = (content, expected) => {
  if (typeof content !== "string") return null;
  let s = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const tryParse = (t) => {
    try {
      const o = JSON.parse(t);
      const a = Array.isArray(o)
        ? o
        : o.translations || o.translation || o.lines || o.data;
      if (Array.isArray(a) && a.length === expected) {
        return a.map((x) => (typeof x === "string" ? x : x && x.text) || "");
      }
    } catch (e) {}
    return null;
  };
  let r = tryParse(s);
  if (r) return r;
  const l = s.indexOf("["), rIdx = s.lastIndexOf("]");
  if (l >= 0 && rIdx > l) {
    r = tryParse(s.slice(l, rIdx + 1));
    if (r) return r;
  }
  const f = s.indexOf("{"), lb = s.lastIndexOf("}");
  if (f >= 0 && lb > f) return tryParse(s.slice(f, lb + 1));
  return null;
};

// 返回体是 JSON 数组，与输入等长、顺序一致。指定 sl 时每项是字符串；
// sl=auto 时每项是 [译文, 识别出的源语言]，取首元素。
// HTTP 200 不足以判定成功：实测大批次里出现过非空输入拿回 "" 的情况，
// 放过去会把空译文写进缓存、该行以后永远不再重译，所以整批判失败重来
const extractGoogle = (data, lines) => {
  let a;
  try { a = JSON.parse(data); } catch (e) { return null; }
  if (typeof a === "string") a = [a];
  if (!Array.isArray(a) || a.length !== lines.length) return null;
  const out = a.map((x) =>
    typeof x === "string" ? x : Array.isArray(x) && typeof x[0] === "string" ? x[0] : ""
  );
  for (let i = 0; i < out.length; i++) {
    if (!out[i] && lines[i].trim()) return null;
  }
  return out;
};

const tag = isGoogle ? "gt" : "llm";

const translateChunk = async (lines, deadline, srcLang) => {
  for (let attempt = 0; attempt < 2; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining < 5000) {
      log(`deadline near, skip ${lines.length} lines`);
      return null;
    }
    try {
      const timeout = Math.min(apiTimeout, Math.floor(remaining / 1000) - 2);
      const req = isGoogle ? buildGoogleReq(lines, srcLang) : buildOpenAIReq(lines);
      const { err, status, data } = await httpPost(req, timeout);
      if (err === "timeout") {
        // 兜底定时触发时在途请求并未取消，重试会让同一批行有两个请求同时在飞
        // （双倍计费，先回的还会被丢弃）；预算内也跑不完第二次，直接放弃这批
        log(`${tag} timeout, drop ${lines.length} lines`);
        return null;
      }
      if (err || !status || status < 200 || status >= 300) {
        log(`${tag} ${status || err} retry=${attempt}`);
        continue;
      }
      let arr;
      if (isGoogle) {
        arr = extractGoogle(data, lines);
      } else {
        const obj = JSON.parse(data);
        const content = obj && obj.choices && obj.choices[0] && obj.choices[0].message && obj.choices[0].message.content;
        arr = extractTranslations(content, lines.length);
      }
      if (arr) return arr;
      log(`${tag} output mismatch expect=${lines.length} retry=${attempt}`);
    } catch (e) {
      log(`${tag} error ${e} retry=${attempt}`);
    }
  }
  return null;
};

// 分批并发翻译；返回 Map(原文→译文)，失败的行不放入 map（回退原文）。
// deadline 之后不再取新批次/重试，已完成的行照常可用
const translateAll = async (uniqueLines, deadline, srcLang) => {
  const chunks = [];
  for (let i = 0; i < uniqueLines.length; i += chunkLines) {
    chunks.push(uniqueLines.slice(i, i + chunkLines));
  }
  const results = new Array(chunks.length).fill(null);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(CONCURRENCY, chunks.length) },
    async () => {
      while (cursor < chunks.length && Date.now() < deadline - 3000) {
        const i = cursor++;
        results[i] = await translateChunk(chunks[i], deadline, srcLang);
      }
    }
  );
  await Promise.all(workers);
  const map = new Map();
  results.forEach((arr, i) => {
    if (arr) arr.forEach((t, j) => map.set(chunks[i][j], t));
  });
  log(`translated ${map.size}/${uniqueLines.length} lines`);
  return map;
};

const loadCache = () => {
  try {
    const c = JSON.parse($persistentStore.read(CACHE_KEY) || "{}");
    return c && c.data && Array.isArray(c.order) ? c : { order: [], data: {} };
  } catch (e) {
    return { order: [], data: {} };
  }
};

// 字符串的 UTF-8 字节数（JS length 是 UTF-16 code unit，中文一字三元组，
// 代理对按两个单元各计 2 字节）
const utf8Len = (s) => {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0xd800 || c > 0xdfff ? 3 : 2;
  }
  return n;
};

const saveCache = (c) => {
  while (c.order.length > CACHE_MAX) delete c.data[c.order.shift()];
  let s = JSON.stringify(c);
  while (utf8Len(s) > CACHE_MAX_BYTES && c.order.length > 1) {
    delete c.data[c.order.shift()];
    s = JSON.stringify(c);
  }
  // 最后一组仍超限时裁剪该字典最旧行：按每行精确序列化字节定位最小
  // 删除前缀，删完序列化一次；估算不足时逐条核验兜底
  if (utf8Len(s) > CACHE_MAX_BYTES && c.order.length === 1) {
    const d = c.data[c.order[0]] || {};
    const ks = Object.keys(d);
    let excess = utf8Len(s) - CACHE_MAX_BYTES;
    let i = 0;
    while (i < ks.length && excess > 0) {
      const k = ks[i++];
      // "key":"value", —— 引号算入 JSON.stringify，另加冒号与逗号
      excess -= utf8Len(JSON.stringify(k)) + utf8Len(JSON.stringify(d[k])) + 2;
      delete d[k];
    }
    s = JSON.stringify(c);
    while (i < ks.length && utf8Len(s) > CACHE_MAX_BYTES) {
      delete d[ks[i++]];
      s = JSON.stringify(c);
    }
  }
  $persistentStore.write(s, CACHE_KEY);
};

(async () => {
  const body = $response.body;
  const finish = (b, why) => {
    log(`done ${why} ${ms()}ms out=${b == null ? "unmodified" : b.length}`);
    if (b == null) return $done({});
    const headers = cleanHeaders();
    return $done(headers ? { body: b, headers } : { body: b });
  };
  try {
    log("in=" + (body == null ? 0 : body.length) + " mode=" + cfg.mode);
    if (cfg.mode === "off") {
      log(`mode=off, untouched ${ms()}ms`);
      return $done({});
    }
    if (!body) return finish(null, "no-body");
    if (cfg.mode === "headers") return finish(body, "mode=headers");
    const url = $request.url || "";
    if (!isGoogle && !cfg.apiKey) {
      log("no api_key, DeepSeek/OpenAI 需要在 BoxJS 中填写 youtube_subtitle.api_key，pass through");
      return finish(body, "no-key");
    }
    if (getParam(url, "tlang")) {
      log("tlang present (app 内自动翻译), pass through");
      return finish(body, "tlang");
    }
    const format = detectFormat(url, body);
    if (!format) return finish(body, "unknown-format");
    const parsed = parseSubtitles(format, body);
    if (!parsed || !parsed.items.length) return finish(body, "parse-empty");
    log(`format=${format} parse=${ms()}ms`);

    const v = getParam(url, "v") || "";
    const lang = getParam(url, "lang") || "";
    const kind = getParam(url, "kind") || "";
    const texts = parsed.items.filter((i) => i.text.trim()).map((i) => i.text);

    // 译文字典：按 服务商|模型|源语言|目标语言 分组的行级 原文→译文 表，
    // 与字幕格式/双语位置无关，跨视频复用；缺行只补未翻部分。
    // 源语言必须进 key——同形异义词（英德 die）译文不同；JSON.stringify 防
    // 可配置值含 | 撞键
    const dictKey = JSON.stringify([cfg.provider, model, lang, cfg.targetLang]);
    const cache = cfg.cache ? loadCache() : null;
    const rawDict = cache && cache.data[dictKey];
    const dict = Object.assign(
      Object.create(null),
      rawDict && typeof rawDict === "object" ? rawDict : null
    );

    const unique = [...new Set(texts)];
    // 空串译文视为未完成，下次重试
    const missing = unique.filter((l) => typeof dict[l] !== "string" || !dict[l]);
    log(`${v} ${lang} kind=${kind || "manual"} cues=${texts.length} unique=${unique.length} miss=${missing.length} -> ${cfg.provider}/${model} -> ${cfg.targetLang}`);

    if (missing.length) {
      const deadline = Date.now() + cfg.budgetMs;
      log(`translate start ${ms()}ms`);
      const got = await translateAll(missing, deadline, lang);
      log(`translate done ${ms()}ms`);
      for (const [k, t] of got) dict[k] = t;
    }

    const map = new Map();
    for (const l of unique) {
      const t = dict[l];
      if (typeof t === "string" && t) map.set(l, t);
    }
    if (!map.size) {
      log("no translations available, keep original");
      return finish(body, "no-translation");
    }
    const merged = parsed.rebuild(map);
    log(`rebuild done ${ms()}ms out=${merged.length}`);

    if (cache) {
      // 命中也刷新 LRU；保存前重读缓存再合并——缩小并发覆盖窗口。
      // 只合并本请求字幕用到/新翻的行：整体回写旧快照会把并发方已淘汰的行
      // 复活到最新位并挤掉新行；本组被并发方淘汰（existing 缺失）时才用全量
      // dict 恢复，顺带保证 order 与 data 不产生幽灵项
      const fresh = loadCache();
      fresh.order = fresh.order.filter((k) => k !== dictKey).concat(dictKey);
      const existing = fresh.data[dictKey];
      const used = Object.create(null);
      for (const l of unique) {
        const t = dict[l];
        if (typeof t === "string" && t) used[l] = t;
      }
      // null 原型合并：字幕行若含 "__proto__" 字面量不会触发 setter
      const mergedDict = Object.assign(
        Object.create(null),
        existing && typeof existing === "object" ? existing : dict,
        used
      );
      const ks = Object.keys(mergedDict);
      if (ks.length > DICT_MAX) {
        for (const k of ks.slice(0, ks.length - DICT_MAX)) delete mergedDict[k];
      }
      fresh.data[dictKey] = mergedDict;
      saveCache(fresh);
    }
    if (cfg.mode === "passthrough") return finish(body, "mode=passthrough");
    return finish(merged, "ok");
  } catch (e) {
    log(`fatal ${e && e.stack ? e.stack : e}`);
    return finish(body, "fatal");
  }
})();
