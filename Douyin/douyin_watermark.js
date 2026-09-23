/*
 * 抖音视频/图集/评论区去水印（Surge http-response 脚本）
 * - 视频：解除下载限制，download_addr/download_suffix_logo_addr 换为播放流，
 *   并把对象内所有 /playwm/ 水印流地址改写为 /play/ 无水印地址
 * - 图集：images[].download_url_list 换为原图 url_list；image_post_info 的
 *   owner/user_watermark_image 换为无水印变体
 * - 评论区：image_list/comment_pic 的 download_url 换为 origin_url 原图
 *   （download_url 是服务端渲染的 sc=watermark 水印变体）；video_list 按
 *   视频同样处理，实况/贴纸等其余字段深度改写 /playwm/ 兜底
 * 水印由服务端渲染，改写字段后客户端直接取得无水印源，无需缓存跨请求改写。
 */

const deWatermarkUrl = (u) =>
  typeof u === "string" ? u.replace(/\/playwm\//g, "/play/") : u;

// 深度遍历替换 /playwm/ → /play/，兼容 video_list、live_photo 等未穷举结构
const deepFix = (node, depth) => {
  if (depth > 8 || node == null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const v = node[i];
      if (typeof v === "string") node[i] = deWatermarkUrl(v);
      else deepFix(v, depth + 1);
    }
  } else {
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (typeof v === "string") node[k] = deWatermarkUrl(v);
      else deepFix(v, depth + 1);
    }
  }
};

// 视频对象：先去水印化全部流地址，再让下载入口复用播放流
const unlockVideoFields = (video) => {
  if (!video || typeof video !== "object") return;
  deepFix(video, 0);
  if (Array.isArray(video.play_addr?.url_list) && video.play_addr.url_list.length) {
    video.download_addr = video.play_addr;
    video.download_suffix_logo_addr = video.play_addr;
  }
  delete video.misc_download_addrs;
  if ("has_watermark" in video) video.has_watermark = false;
};

// aweme 条目：解除保存限制，处理视频、图集与图集 v2 的水印字段
const unlockAweme = (a) => {
  if (!a || typeof a !== "object") return;
  a.prevent_download = false;
  if (a.status) a.status.reviewed = 1;
  if (a.video_control) {
    a.video_control.allow_download = true;
    a.video_control.prevent_download_type = 0;
  }
  unlockVideoFields(a.video);

  const acl = a.aweme_acl;
  const dg = acl && acl.download_general;
  if (dg && typeof dg === "object") {
    dg.mute = false;
    if (dg.extra) {
      delete dg.extra;
      dg.code = 0;
      dg.show_type = 2;
      dg.transcode = 3;
      acl.download_mask_panel = dg;
      acl.share_general = dg;
    }
  }

  for (const img of a.images || []) {
    if (Array.isArray(img?.url_list) && img.url_list.length) {
      img.download_url_list = img.url_list;
    }
    // 实况图挂的视频走同一套视频改写
    if (img?.video && typeof img.video === "object") unlockVideoFields(img.video);
    else deepFix(img, 0);
  }

  const ipi = a.image_post_info?.images;
  if (Array.isArray(ipi)) {
    for (const img of ipi) {
      if (img?.owner_watermark_image && img?.display_image?.url_list) {
        img.owner_watermark_image.url_list = img.display_image.url_list;
      }
      if (img?.user_watermark_image && img?.thumbnail?.url_list) {
        img.user_watermark_image.url_list = img.thumbnail.url_list;
      }
      deepFix(img, 0);
    }
    a.without_watermark = true;
  }

  for (const lv of a.long_video || []) {
    if (lv?.video) unlockVideoFields(lv.video);
  }
};

// 评论：图片 download_url 是 sc=watermark 水印变体，换成 origin_url 原图；
// 视频评论按视频改写；深度处理兜底实况图等结构的 /playwm/
const fixComment = (c) => {
  if (!c || typeof c !== "object") return;
  deepFix(c, 0);
  for (const key of ["image_list", "comment_pic"]) {
    for (const img of c[key] || []) {
      if (img?.origin_url) img.download_url = img.origin_url;
    }
  }
  for (const v of c.video_list || []) {
    const vv = (v && typeof v === "object" && v.video) || v;
    unlockVideoFields(vv);
  }
  for (const sc of c.reply_comment || []) fixComment(sc);
};

const body = $response.body;

let obj = null;
if (body) {
  try {
    obj = JSON.parse(body);
  } catch (e) {
    obj = null;
  }
}

if (obj == null) {
  // 非 JSON（如 protobuf 信息流）原样放行
  $done(body ? { body } : {});
} else {
  // 信息流：feed/post/detail/favorite/related/搜索等返回的 aweme 条目
  for (const key of ["aweme_list", "aweme_details"]) {
    if (Array.isArray(obj[key])) {
      for (const a of obj[key]) unlockAweme(a);
    }
  }
  if (obj.aweme_detail) unlockAweme(obj.aweme_detail);

  const data = obj.data;
  const blocks = Array.isArray(data) ? data : data ? [data] : [];
  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;
    if (b.aweme) unlockAweme(b.aweme);
    if (b.aweme_info) unlockAweme(b.aweme_info);
    if (!b.aweme && !b.aweme_info && (b.video || b.images || b.image_post_info)) {
      unlockAweme(b);
    }
    for (const it of b.items || []) {
      if (it?.aweme) unlockAweme(it.aweme);
    }
  }

  // 评论区：list 与 list/reply 都落在 comments / data.comments
  for (const list of [obj.comments, obj.data?.comments, obj.data?.comment_list]) {
    if (Array.isArray(list)) {
      for (const c of list) fixComment(c);
    }
  }

  $done({ body: JSON.stringify(obj) });
}
