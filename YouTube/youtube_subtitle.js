/*
 * YouTube App 双语字幕（Surge http-response 脚本）
 * - 拦截 www/m.youtube.com/api/timedtext 的字幕响应，逐行调用 OpenAI 兼容
 *   接口（DeepSeek / OpenAI 二选一）翻译，按原格式回写成双语字幕
 * - srv3(ttml/xml)：每个 <p> cue 内以 &#x000A; 追加译文行
 *   json3：每个 event 的 segs 合并为一段 utf8，以 \n 追加译文行
 * - 参数全部在 BoxJS《YouTube AI双语字幕》中调整：
 *   服务商 / API Key / Base URL / 模型 / 目标语言 / 双语位置 / 翻译缓存
 * - App 内手动选择"自动翻译"语言的请求（URL 带 tlang）原样放行；
 *   未配置 API Key、格式不识别或翻译失败时同样原样返回，不影响原始字幕
 */

const PROVIDERS = {
  deepseek: { base: "https://api.deepseek.com", model: "deepseek-chat" },
  openai: { base: "https://api.openai.com/v1", model: "gpt-4o-mini" },
};

const CHUNK_LINES = 45; // 每次请求翻译的行数
const CONCURRENCY = 3; // 并发翻译请求数
const API_TIMEOUT = 45; // 单次 LLM 请求超时（秒）
const CACHE_KEY = "youtube_subtitle.cache.data";
const CACHE_MAX = 6; // 缓存的视频字幕条数（LRU）
const CACHE_MAX_BYTES = 400 * 1024; // 持久化体积上限

const readKey = (n, dft) => {
  const v = $persistentStore.read(`youtube_subtitle.${n}`);
  return v === undefined || v === null || v === "" ? dft : v;
};

const cfg = {
  provider: readKey("provider", "deepseek"),
  apiKey: readKey("api_key", ""),
  baseUrl: readKey("base_url", ""),
  model: readKey("model", ""),
  targetLang: readKey("target_lang", "简体中文"),
  position: readKey("position", "below"), // below=原上译下 above=译上原下 only=仅译文
  cache: String(readKey("cache", "true")) !== "false",
};

const provider = PROVIDERS[cfg.provider] || PROVIDERS.deepseek;
const endpoint = `${(cfg.baseUrl || provider.base).replace(/\/+$/, "")}/chat/completions`;
const model = cfg.model || provider.model;

const log = (m) => console.log(`[yt-sub] ${m}`);

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

const breakLine = { xml: "&#x000A;", json: "\n" };

// 按 position 拼接原文与译文；无译文时回退原文
const compose = (orig, trans, br) => {
  if (!trans) return orig;
  if (cfg.position === "only") return trans;
  return cfg.position === "above"
    ? `${trans}${br}${orig}`
    : `${orig}${br}${trans}`;
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
    return {
      format,
      items,
      rebuild(map) {
        for (const it of items) {
          it.ev.segs = [{ utf8: compose(it.text, map.get(it.text), "\n") }];
          delete it.ev.wWinId;
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
    items.push({ attrs, text, skip: !text.trim() });
  }
  if (!items.some((i) => !i.skip)) return null;
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
        if (it.skip) {
          out += m[0];
        } else {
          const t = map.get(it.text);
          const orig = xmlEscape(it.text);
          // 分行实体 &#x000A; 不能过 xmlEscape，先各自转义再拼接
          const inner = !t
            ? orig
            : cfg.position === "only"
              ? xmlEscape(t)
              : cfg.position === "above"
                ? `${xmlEscape(t)}${breakLine.xml}${orig}`
                : `${orig}${breakLine.xml}${xmlEscape(t)}`;
          out += `<p${it.attrs}>${inner}</p>`;
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

const httpPost = (payload) =>
  new Promise((resolve) => {
    $httpClient.post(
      {
        url: endpoint,
        timeout: API_TIMEOUT,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(payload),
      },
      (err, resp, data) => resolve({ err, status: resp && resp.status, data })
    );
  });

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

const translateChunk = async (lines) => {
  const payload = {
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
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { err, status, data } = await httpPost(payload);
      if (err || !status || status < 200 || status >= 300) {
        log(`llm ${status || err} retry=${attempt}`);
        continue;
      }
      const obj = JSON.parse(data);
      const content = obj && obj.choices && obj.choices[0] && obj.choices[0].message && obj.choices[0].message.content;
      const arr = extractTranslations(content, lines.length);
      if (arr) return arr;
      log(`llm output mismatch expect=${lines.length} retry=${attempt}`);
    } catch (e) {
      log(`llm error ${e} retry=${attempt}`);
    }
  }
  return null;
};

// 分批并发翻译；返回 Map(原文→译文)，失败的行不放入 map（回退原文）
const translateAll = async (uniqueLines) => {
  const chunks = [];
  for (let i = 0; i < uniqueLines.length; i += CHUNK_LINES) {
    chunks.push(uniqueLines.slice(i, i + CHUNK_LINES));
  }
  const results = new Array(chunks.length).fill(null);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(CONCURRENCY, chunks.length) },
    async () => {
      while (cursor < chunks.length) {
        const i = cursor++;
        results[i] = await translateChunk(chunks[i]);
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

const saveCache = (c) => {
  while (c.order.length > CACHE_MAX) delete c.data[c.order.shift()];
  let s = JSON.stringify(c);
  while (s.length > CACHE_MAX_BYTES && c.order.length > 1) {
    delete c.data[c.order.shift()];
    s = JSON.stringify(c);
  }
  $persistentStore.write(s, CACHE_KEY);
};

(async () => {
  const body = $response.body;
  const finish = (b) => $done({ body: b });
  try {
    const url = $request.url || "";
    if (!body) return finish(body);
    if (!cfg.apiKey) {
      log("no api_key, pass through (BoxJS 中填写 youtube_subtitle.api_key)");
      return finish(body);
    }
    if (getParam(url, "tlang")) {
      log("tlang present (app 内自动翻译), pass through");
      return finish(body);
    }
    const format = detectFormat(url, body);
    if (!format) return finish(body);
    const parsed = parseSubtitles(format, body);
    if (!parsed || !parsed.items.length) return finish(body);

    const v = getParam(url, "v") || "";
    const lang = getParam(url, "lang") || "";
    const kind = getParam(url, "kind") || "";
    const texts = parsed.items.filter((i) => i.text.trim()).map((i) => i.text);
    const sig = [
      v, lang, kind, cfg.provider, model, cfg.targetLang, cfg.position,
      texts.length, texts[0] || "", texts[texts.length - 1] || "",
    ].join("|");

    const cache = cfg.cache ? loadCache() : null;
    if (cache && cache.data[sig]) {
      cache.order = cache.order.filter((k) => k !== sig).concat(sig);
      saveCache(cache);
      log(`cache hit ${v} ${lang}`);
      return finish(cache.data[sig]);
    }

    const unique = [...new Set(texts)];
    log(`${v} ${lang} cues=${texts.length} unique=${unique.length} -> ${cfg.provider}/${model} -> ${cfg.targetLang}`);
    const map = await translateAll(unique);
    if (!map.size) {
      log("all translations failed, keep original");
      return finish(body);
    }
    const merged = parsed.rebuild(map);

    if (cache && map.size) {
      cache.order.push(sig);
      cache.data[sig] = merged;
      saveCache(cache);
    }
    return finish(merged);
  } catch (e) {
    log(`fatal ${e && e.stack ? e.stack : e}`);
    return finish(body);
  }
})();
