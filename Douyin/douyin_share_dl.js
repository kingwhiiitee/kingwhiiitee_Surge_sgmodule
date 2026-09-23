// 抖音分享页无水印下载注入
// 覆盖 iesdouyin.com / douyin.com 分享页（网页无证书固定，可 MITM 改写）。
// 解析 _ROUTER_DATA / RENDER_DATA 中的 aweme 数据，取无水印原始地址，
// 在页面底部注入下载栏：点击在新标签页打开原片/原图，长按或分享即可存入相册。

// URL 选择：优先无水印（剔除 playwm/水印参数变体）
const pickUrl = (list) => {
  if (!Array.isArray(list)) return null;
  const urls = list.filter((u) => typeof u === "string" && /^https?:/.test(u));
  if (!urls.length) return null;
  return (
    urls.find((u) => !u.includes("playwm") && !u.includes("watermark")) ||
    urls[0].replace(/playwm/g, "play")
  );
};

const collectItems = (a) => {
  const out = [];
  if (!a || typeof a !== "object") return out;
  const v = a.video;
  if (v && typeof v === "object") {
    const u =
      pickUrl(v.play_addr?.url_list) ||
      pickUrl(v.download_addr?.url_list) ||
      pickUrl(v.play_addr_lowbr?.url_list) ||
      pickUrl(v.bit_rate?.[0]?.play_addr?.url_list);
    // 图文的 video 是配乐 mp3，不是内容本体，跳过
    if (u && !/\.mp3|ies-music|music-hj/.test(u)) out.push({ t: "视频", u });
  }
  const imgs = a.images;
  if (Array.isArray(imgs)) {
    imgs.forEach((im, i) => {
      if (!im || typeof im !== "object") return;
      const u =
        pickUrl(im.url_list) ||
        pickUrl(im.watermark_free_download_url_list) ||
        pickUrl(im.download_url_list);
      if (u) out.push({ t: `图${i + 1}`, u });
    });
  }
  return out;
};

// 树遍历收集目标 aweme（有 targetId 时只收该 id，排除推荐位；无 id 时只收第一个，避免重复）
const walk = (n, items, depth, targetId) => {
  if (depth > 30 || !n || typeof n !== "object") return;
  if (typeof n.aweme_id === "string" && n.aweme_id) {
    if (targetId ? n.aweme_id === targetId : items.length === 0) {
      collectItems(n).forEach((it) => items.push(it));
    }
  }
  for (const k in n) {
    const v = n[k];
    if (v && typeof v === "object") walk(v, items, depth + 1, targetId);
  }
};

const fromJson = (json, items, targetId) => {
  try {
    walk(JSON.parse(json), items, 0, targetId);
  } catch (e) {}
};

// 截取目标 aweme 在 HTML 中的区间，防止推荐位/头像等无关字段混入
const awemeSlice = (html, targetId) => {
  let start = 0;
  let end = html.length;
  if (targetId) {
    const i = html.indexOf(`"aweme_id":"${targetId}"`);
    if (i >= 0) {
      start = i;
      const nxt = html.indexOf('"aweme_id":"', i + 12);
      if (nxt > 0) end = nxt;
    }
  }
  return html.slice(start, end);
};

// 按 JSON 括号深度截取 "images":[ ... ] 完整数组文本
const sliceJsonArray = (html, key) => {
  const ki = html.indexOf(`"${key}":[`);
  if (ki < 0) return "";
  const j = html.indexOf("[", ki);
  let depth = 0;
  for (let i = j; i < html.length; i++) {
    const c = html[i];
    if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") {
      depth--;
      if (!depth) return html.slice(j, i + 1);
    }
  }
  return "";
};

// 兜底：JSON 解析失败时，只在目标 aweme 的 images 数组内抠 url_list
const fallback = (html, items, targetId) => {
  const un = (s) => s.replace(/\\u002F/gi, "/").replace(/\\u0026/gi, "&").replace(/\\\//g, "/");
  const seen = new Set(items.map((i) => i.u));
  const seg = awemeSlice(html, targetId);
  let m;
  const vp = /"play_addr"\s*:\s*\{[^{}]*?"url_list"\s*:\s*\[\s*"([^"]+)"/g;
  while ((m = vp.exec(seg))) {
    const u = un(m[1]).replace(/playwm/g, "play");
    if (!seen.has(u)) {
      seen.add(u);
      items.push({ t: "视频", u });
    }
  }
  const arr = sliceJsonArray(seg, "images");
  if (!arr) return;
  const ip = /"(\w+_list)"\s*:\s*\[\s*"([^"]+)"/g;
  let idx = 1;
  while ((m = ip.exec(arr))) {
    if (m[1] !== "url_list" && m[1] !== "watermark_free_download_url_list") continue;
    const u = un(m[2]);
    if (/playwm|\/play\//.test(u) || /\.(m3u8|mp4)/.test(u) || /water/i.test(u)) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    items.push({ t: `图${idx++}`, u });
  }
};

const buildPanel = (items) => {
  const data = JSON.stringify(items).replace(/</g, "\\u003c");
  return (
    `<script>(function(){try{` +
    `var items=${data};` +
    `var d=document,e=d.createElement('div');` +
    `e.style.cssText='position:fixed;left:0;right:0;bottom:0;z-index:2147483647;` +
    `background:rgba(0,0,0,.92);color:#fff;font:14px/1.5 -apple-system,sans-serif;` +
    `padding:10px 12px;display:flex;align-items:center;flex-wrap:wrap;gap:8px;';` +
    `var t=d.createElement('b');t.textContent='无水印下载';t.style.color='#fe2c55';e.appendChild(t);` +
    `items.forEach(function(it){` +
    `var b=d.createElement('button');b.textContent=it.t;` +
    `b.style.cssText='background:#fe2c55;color:#fff;border:0;border-radius:6px;padding:6px 12px;font-size:14px;';` +
    `b.onclick=function(){window.open(it.u,'_blank');};e.appendChild(b);});` +
    `var x=d.createElement('button');x.textContent='\\u00d7';` +
    `x.style.cssText='background:none;color:#999;border:0;font-size:18px;margin-left:auto;';` +
    `x.onclick=function(){e.remove();};e.appendChild(x);` +
    `(d.body||d.documentElement).appendChild(e);` +
    `}catch(_){}})();</script>`
  );
};

// 无 SSR 数据时注入轻量轮询器：页面 JS 补齐 _ROUTER_DATA 后在浏览器端再抽取一次
const buildLoader = (targetId) => {
  const t = JSON.stringify(targetId || "");
  return (
    `<script>(function(){try{` +
    `var pickUrl=${pickUrl.toString()};` +
    `var collectItems=${collectItems.toString()};` +
    `var walk=${walk.toString()};` +
    `var T=${t},tries=0,iv=setInterval(function(){` +
    `tries++;` +
    `var items=[];` +
    `try{` +
    `var rd=window._ROUTER_DATA;` +
    `if(!rd){` +
    `var ss=document.querySelectorAll('script'),txt='';` +
    `for(var i=0;i<ss.length;i++){if(/_ROUTER_DATA\\s*=/.test(ss[i].textContent)){txt=ss[i].textContent;break;}}` +
    `if(txt){var b=txt.indexOf('{');if(b>=0)rd=JSON.parse(txt.slice(b).replace(/;\\s*$/,''));}` +
    `}` +
    `if(rd)walk(rd,items,0,T);` +
    `}catch(_){}` +
    `if(!items.length&&tries<40)return;` +
    `clearInterval(iv);` +
    `if(!items.length)return;` +
    `var seen=new Set();items=items.filter(function(i){return !seen.has(i.u)&&seen.add(i.u);});` +
    `var d=document,e=d.createElement('div');` +
    `e.style.cssText='position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:rgba(0,0,0,.92);color:#fff;font:14px/1.5 -apple-system,sans-serif;padding:10px 12px;display:flex;align-items:center;flex-wrap:wrap;gap:8px;';` +
    `var t2=d.createElement('b');t2.textContent='无水印下载';t2.style.color='#fe2c55';e.appendChild(t2);` +
    `items.forEach(function(it){` +
    `var b2=d.createElement('button');b2.textContent=it.t;` +
    `b2.style.cssText='background:#fe2c55;color:#fff;border:0;border-radius:6px;padding:6px 12px;font-size:14px;';` +
    `b2.onclick=function(){window.open(it.u,'_blank');};e.appendChild(b2);});` +
    `var x=d.createElement('button');x.textContent='\\u00d7';` +
    `x.style.cssText='background:none;color:#999;border:0;font-size:18px;margin-left:auto;';` +
    `x.onclick=function(){e.remove();};e.appendChild(x);` +
    `(d.body||d.documentElement).appendChild(e);` +
    `},500);` +
    `}catch(_){}})();</script>`
  );
};

const body = $response.body;
const targetId = (($request && $request.url) || "").match(/(?:video|note|image|slides|music)\/(\d{4,})/)?.[1] || "";
let items = [];
let out = typeof body === "string" ? body : "";

if (out) {
  let m = out.match(/_ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);
  if (m) fromJson(m[1], items, targetId);
  if (!items.length) {
    m = out.match(/id=["']RENDER_DATA["'][^>]*>([^<]+)/);
    if (m) {
      try {
        fromJson(decodeURIComponent(m[1]), items, targetId);
      } catch (e) {}
    }
  }
  if (!items.length) fallback(out, items, targetId);
}

let inject = "";
if (items.length) {
  const seen = new Set();
  items = items.filter((i) => !seen.has(i.u) && seen.add(i.u));
  inject = buildPanel(items);
} else if (/_ROUTER_DATA|RENDER_DATA/.test(out)) {
  // 分享页但 SSR 未含媒体：交给浏览器端轮询
  inject = buildLoader(targetId);
}

if (!inject) {
  $done({});
} else {
  if (/<\/body>/i.test(out)) out = out.replace(/<\/body>/i, inject + "</body>");
  else out += inject;
  $done({ body: out });
}
