/*
 * 小红书图片去水印（Surge http-response 脚本）
 * - 图文笔记：关闭 media_save_config 的保存限制与水印，放行 image_download 开关
 * - 实况照片：以笔记 feed 缓存中的无水印流地址替换 live_photo/save 返回
 * - 评论区：贴纸类评论转图片类型（可保存），剥离水印中携带的 red_id
 * 配合 [Map Local] 将水印配置图替换为 1px 透明图，客户端无法叠加水印。
 */

const FEED_CACHE_KEY = "kingwhiiitee.xhs.images_list";

const url = $request.url;
const body = $response.body;
if (!body) {
  $done({});
}

let obj;
try {
  obj = JSON.parse(body);
} catch (e) {
  $done({ body });
}

const readStore = (key) =>
  typeof $persistentStore !== "undefined"
    ? $persistentStore.read(key)
    : typeof $prefs !== "undefined"
      ? $prefs.valueForKey(key)
      : null;

const writeStore = (key, value) =>
  typeof $persistentStore !== "undefined"
    ? $persistentStore.write(value, key)
    : typeof $prefs !== "undefined"
      ? $prefs.setValueForKey(value, key)
      : false;

// 分辨率优先，其次平均码率
const pickStreamUrl = (streams) => {
  if (!Array.isArray(streams)) return null;
  const sorted = streams
    .filter((s) => s && s.master_url)
    .sort(
      (a, b) =>
        (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0) ||
        (b.avg_bitrate || 0) - (a.avg_bitrate || 0)
    );
  return sorted.length ? sorted[0].master_url : null;
};

// 图文笔记：解除保存限制、关闭水印，并缓存 images_list 供实况照片保存使用
if (url.includes("/note/imagefeed") || url.includes("/note/feed")) {
  const blocks = Array.isArray(obj?.data) ? obj.data : obj?.data ? [obj.data] : [];
  let cached = false;
  for (const block of blocks) {
    if (!Array.isArray(block?.note_list)) continue;
    for (const item of block.note_list) {
      item.media_save_config = {
        ...(item.media_save_config || {}),
        disable_save: false,
        disable_watermark: true,
        disable_weibo_cover: true,
      };
      if (Array.isArray(item.function_switch)) {
        for (const sw of item.function_switch) {
          if (sw?.type === "image_download") sw.enable = true;
        }
      }
      if (!cached && Array.isArray(item.images_list) && item.images_list.length) {
        writeStore(FEED_CACHE_KEY, JSON.stringify(item.images_list));
        cached = true;
      }
    }
  }
}

// 实况照片保存：用 feed 缓存里的无水印流地址重写返回
if (url.includes("/note/live_photo/save")) {
  const cache = readStore(FEED_CACHE_KEY);
  if (cache) {
    try {
      const newDatas = [];
      for (const img of JSON.parse(cache) || []) {
        const media = img?.live_photo?.media;
        if (!img?.live_photo_file_id || !media?.video_id) continue;
        const streamUrl =
          pickStreamUrl(media?.stream?.h265) || pickStreamUrl(media?.stream?.h264);
        if (!streamUrl) continue;
        newDatas.push({
          file_id: img.live_photo_file_id,
          video_id: media.video_id,
          url: streamUrl,
        });
      }
      if (newDatas.length) {
        if (Array.isArray(obj?.data?.datas)) {
          obj.data.datas = obj.data.datas.map((d) => {
            const hit = newDatas.find((n) => n.file_id === d?.file_id);
            return hit ? { ...d, url: hit.url } : d;
          });
        } else {
          obj = { code: 0, success: true, msg: "ok", data: { datas: newDatas } };
        }
      }
    } catch (e) {}
  }
}

// 评论区：贴纸类评论转图片类型可保存，递归剥离水印里的 red_id
if (url.includes("/note/comment/list") || url.includes("/note/comment/sub_comments")) {
  const stripRedId = (node) => {
    if (Array.isArray(node)) {
      node.forEach(stripRedId);
    } else if (node && typeof node === "object") {
      if ("red_id" in node) delete node.red_id;
      for (const key of Object.keys(node)) stripRedId(node[key]);
    }
  };
  const fixComment = (c) => {
    if (c?.comment_type === 3) c.comment_type = 2;
    if (c?.media_source_type === 1) c.media_source_type = 0;
  };
  stripRedId(obj);
  const comments = [...(obj?.data?.comments || []), ...(obj?.data?.sub_comments || [])];
  for (const c of comments) {
    fixComment(c);
    for (const sc of c?.sub_comments || []) fixComment(sc);
  }
}

$done({ body: JSON.stringify(obj) });
