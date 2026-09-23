/*
 * 抖音视频/图集/评论区去水印（Surge http-response 脚本）
 * - 视频：解除下载限制（含"此类型视频暂不支持下载"的类型级限制），
 *   download_addr/download_suffix_logo_addr 换为播放流，
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
  video.prevent_download = false;
  deepFix(video, 0);
  if (Array.isArray(video.play_addr?.url_list) && video.play_addr.url_list.length) {
    video.download_addr = video.play_addr;
    video.download_suffix_logo_addr = video.play_addr;
  }
  delete video.misc_download_addrs;
  if ("has_watermark" in video) video.has_watermark = false;
};

// ACLCommonShare 归一化为"允许"：code=0/show_type=2/transcode=3 放行下载，
// mute=false 保留音轨；extra 与 toast_msg 是限制原因与提示文案的载体，一并移除
const fixAclShare = (p) => {
  if (!p || typeof p !== "object") return;
  p.code = 0;
  p.show_type = 2;
  p.transcode = 3;
  p.mute = false;
  delete p.extra;
  delete p.toast_msg;
};

// aweme 条目：解除保存限制，处理视频、图集与图集 v2 的水印字段
const unlockAweme = (a) => {
  if (!a || typeof a !== "object") return;
  a.prevent_download = false;
  a.without_watermark = true;
  a.is_prohibited = false;
  a.can_cache_to_local = true;
  // 来源标记：external_video_type=1/aweme_type=107 被 isAwemeFromXiGua 判为
  // 西瓜视频来源并禁止保存（"作品暂时无法保存"），归一化即可解除
  if ("external_video_type" in a) a.external_video_type = 0;
  if (a.aweme_type === 107) a.aweme_type = 0;
  if ("item_mask_status" in a) a.item_mask_status = 0;
  if ("preview_video_status" in a) a.preview_video_status = 0;
  // 作者/音乐维度的"作者已关闭下载"开关
  if (a.author && typeof a.author === "object") a.author.prevent_download = false;
  if (a.music && typeof a.music === "object") {
    a.music.prevent_download = false;
    a.music.prevent_item_download_status = 0;
  }

  const st = a.status;
  if (st && typeof st === "object") {
    st.reviewed = 1;
    st.allow_share = true;
    st.is_prohibited = false;
    // download_status 是保存按钮置灰的主开关；其余 share/可见性字段同样拦截入口
    st.download_status = 0;
    st.dont_share_status = 0;
    st.share_grayed = false;
    st.is_delete = false;
    st.in_reviewing = false;
    st.is_private = false;
    st.private_status = 0;
    st.self_see = false;
    st.part_see = 0;
  }

  const ac = a.aweme_control;
  if (ac && typeof ac === "object") {
    ac.can_share = true;
    ac.can_forward = true;
  }

  const vc = a.video_control;
  if (vc && typeof vc === "object") {
    vc.allow_download = true;
    vc.allow_share = true;
    vc.share_grayed = false;
    vc.prevent_download_type = 0;
    vc.download_ignore_visibility = true;
    // download_info 是"作者已关闭下载/此类型视频暂不支持下载"提示的直接来源：
    // fail_info.msg 即 toast 文案；可下载状态下只有 level:0
    const di = vc.download_info;
    if (di && typeof di === "object") {
      di.level = 0;
      delete di.fail_info;
    }
  }
  unlockVideoFields(a.video);

  // aweme_acl 的三个下载面板任一带 code!=0 都会拦截保存入口，逐一归一化；
  // download_general 存在时用同一对象覆盖其余面板（已验证的解锁配方）
  const acl = a.aweme_acl;
  if (acl && typeof acl === "object") {
    fixAclShare(acl.download_general);
    const dg = acl.download_general;
    if (dg && typeof dg === "object") {
      acl.download_mask_panel = dg;
      acl.download_share_panel = dg;
      acl.share_general = dg;
    } else {
      fixAclShare(acl.download_mask_panel);
      fixAclShare(acl.download_share_panel);
    }
    fixAclShare(acl.share_general);
  }

  for (const img of a.images || []) {
    // watermark_free_download_url_list 是官方的无水印下载变体，优先使用；
    // 否则回退到 url_list 原图
    const clean =
      (Array.isArray(img?.watermark_free_download_url_list) &&
        img.watermark_free_download_url_list.length &&
        img.watermark_free_download_url_list) ||
      img?.url_list;
    if (Array.isArray(clean) && clean.length) {
      img.download_url_list = clean;
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
  $done({});
} else {
  // 信息流：feed/post/detail/favorite/related/搜索等返回的 aweme 条目
  for (const key of ["aweme_list", "aweme_details", "item_list"]) {
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
    if (b.aweme_detail) unlockAweme(b.aweme_detail);
    for (const a of b.aweme_list || []) unlockAweme(a);
    for (const a of b.item_list || []) unlockAweme(a);
    if (!b.aweme && !b.aweme_info && (b.video || b.images || b.image_post_info)) {
      unlockAweme(b);
    }
    for (const it of b.items || []) {
      if (it?.aweme) unlockAweme(it.aweme);
      if (it?.aweme_info) unlockAweme(it.aweme_info);
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
