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

// 树遍历收集全部 aweme 节点（aweme_id + images/video；img_bitrate 等变体无 aweme_id，跳过）
const walk = (n, items, depth) => {
  if (depth > 30 || !n || typeof n !== "object") return;
  if (typeof n.aweme_id === "string" && n.aweme_id) collectItems(n).forEach((it) => items.push(it));
  for (const k in n) {
    const v = n[k];
    if (v && typeof v === "object") walk(v, items, depth + 1);
  }
};

const fromJson = (json, items) => {
  try {
    walk(JSON.parse(json), items, 0);
  } catch (e) {}
};

// 兜底：JSON 解析失败时直接从 HTML 里抠 url_list
const fallback = (html, items) => {
  const un = (s) => s.replace(/\\u002F/gi, "/").replace(/\\u0026/gi, "&").replace(/\\\//g, "/");
  const seen = new Set(items.map((i) => i.u));
  let m;
  const vp = /"play_addr"\s*:\s*\{[^{}]*?"url_list"\s*:\s*\[\s*"([^"]+)"/g;
  while ((m = vp.exec(html))) {
    const u = un(m[1]).replace(/playwm/g, "play");
    if (!seen.has(u)) {
      seen.add(u);
      items.push({ t: "视频", u });
    }
  }
  const ip = /"url_list"\s*:\s*\[\s*"([^"]+)"/g;
  let idx = 1;
  while ((m = ip.exec(html))) {
    const u = un(m[1]);
    if (/playwm|\/play\//.test(u) || /\.(m3u8|mp4)/.test(u)) continue;
    if (u.includes("watermark")) continue;
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

const body = $response.body;
let items = [];

if (typeof body === "string" && body.length) {
  let m = body.match(/_ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);
  if (m) fromJson(m[1], items);
  if (!items.length) {
    m = body.match(/id=["']RENDER_DATA["'][^>]*>([^<]+)/);
    if (m) {
      try {
        fromJson(decodeURIComponent(m[1]), items);
      } catch (e) {}
    }
  }
  if (!items.length) fallback(body, items);
}

if (!items.length) {
  $done({});
} else {
  const seen = new Set();
  items = items.filter((i) => !seen.has(i.u) && seen.add(i.u));

  const panel = buildPanel(items);
  let out = body;
  if (/<\/body>/i.test(out)) out = out.replace(/<\/body>/i, panel + "</body>");
  else out += panel;

  $done({ body: out });
}
