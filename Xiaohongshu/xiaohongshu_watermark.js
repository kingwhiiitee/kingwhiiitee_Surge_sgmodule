/*
 * 小红书图片/视频去水印（Surge http-response 脚本）
 * - 图文笔记：关闭 media_save_config 的保存限制与水印，放行 image_download 开关
 * - 视频笔记：同上并放行 video_download 入口，按 note_id 缓存最优流地址
 * - 实况照片/视频保存：用缓存的无水印流地址重写 save 响应中的下载地址
 * - 评论区：贴纸类评论转图片类型（可保存），剥离水印中携带的 red_id；
 *   评论实况图/视频的 video_id 缓存无水印流地址，重写下载响应中的 video_url
 * 配合 [Map Local] 将水印配置图替换为 1px 透明图，客户端无法叠加水印。
 */

// 流地址按 业务id 一键一值存储，不同响应写入互不覆盖；索引键记录写入顺序用于
// 淘汰最旧条目，值与索引条目携带 generation，删除前校验一致避免误删新值；
// 索引竞态最多留下孤儿键，不会丢数据。
const LP_PREFIX = "kingwhiiitee.xhs.lp.";
const LP_INDEX_KEY = "kingwhiiitee.xhs.lp.idx";
const LP_MAX = 300;
const VID_PREFIX = "kingwhiiitee.xhs.vid.";
const VID_INDEX_KEY = "kingwhiiitee.xhs.vid.idx";
const VID_MAX = 200;
const CM_PREFIX = "kingwhiiitee.xhs.cm.";
const CM_INDEX_KEY = "kingwhiiitee.xhs.cm.idx";
const CM_MAX = 300;

const [readStore, writeStore] =
  typeof $persistentStore !== "undefined"
    ? [(key) => $persistentStore.read(key), (key, value) => $persistentStore.write(value, key)]
    : typeof $prefs !== "undefined"
      ? [(key) => $prefs.valueForKey(key), (key, value) => $prefs.setValueForKey(value, key)]
      : [() => null, () => false];

const newGen = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const entryId = (e) => (typeof e === "string" ? e : e?.id) || null;

// entries: [[id, streamUrl], ...]
const saveUrls = (keyPrefix, indexKey, maxEntries, entries) => {
  const fresh = new Map();
  for (const [id, url] of entries) {
    if (!id || fresh.has(id)) continue;
    const g = newGen();
    writeStore(keyPrefix + id, JSON.stringify({ g, url }));
    fresh.set(id, g);
  }
  if (!fresh.size) return;

  let index;
  try {
    index = JSON.parse(readStore(indexKey));
  } catch (e) {}
  index = (Array.isArray(index) ? index : []).filter((e) => {
    const id = entryId(e);
    return id && !fresh.has(id);
  });
  for (const [id, g] of fresh) index.push({ id, g });
  for (const e of index.splice(0, Math.max(0, index.length - maxEntries))) {
    // 仅淘汰带 generation 且回读校验一致的条目；旧版索引项不删值，
    // 容忍孤儿键，避免 "读-校验-删" 窗口误删并发刷新的值
    if (e?.g == null) continue;
    const key = keyPrefix + entryId(e);
    try {
      if (JSON.parse(readStore(key))?.g === e.g) writeStore(key, null);
    } catch (err) {}
  }
  writeStore(indexKey, JSON.stringify(index));
};

const getStoredUrl = (keyPrefix, id) => {
  const raw = readStore(keyPrefix + id);
  if (!raw) return null;
  try {
    const url = JSON.parse(raw)?.url;
    return url && typeof url === "string" ? url : null;
  } catch (e) {
    return typeof raw === "string" ? raw : null;
  }
};

// 分辨率优先，其次平均码率
const pickStreamUrl = (streams) => {
  if (!Array.isArray(streams)) return null;
  let best = null, bestArea = 0, bestRate = 0;
  for (const s of streams) {
    if (!s?.master_url) continue;
    const area = (s.width || 0) * (s.height || 0);
    const rate = s.avg_bitrate || 0;
    if (!best || (area - bestArea || rate - bestRate) > 0) {
      best = s;
      bestArea = area;
      bestRate = rate;
    }
  }
  return best ? best.master_url : null;
};

const bestMediaUrl = (media) => pickStreamUrl(media?.stream?.h265) || pickStreamUrl(media?.stream?.h264);

// 关闭保存限制与水印；function_switch 里指定类型的开关放行
const unlockSave = (item, switchTypes) => {
  item.media_save_config = {
    ...item.media_save_config,
    disable_save: false,
    disable_watermark: true,
    disable_weibo_cover: true,
  };
  if (!Array.isArray(item.function_switch)) return;
  for (const sw of item.function_switch) {
    if (!switchTypes.includes(sw?.type)) continue;
    sw.enable = true;
    if (sw.reason) delete sw.reason;
  }
};

// 评论媒体：pictures/videos 条目的 video_info 为 JSON 字符串，含 stream.h265/h264
const collectCommentMedia = (c, pending) => {
  for (const list of [c?.pictures, c?.videos]) {
    if (!Array.isArray(list)) continue;
    for (const p of list) {
      if (!p?.video_id || !p.video_info) continue;
      try {
        const streamUrl = bestMediaUrl(typeof p.video_info === "string" ? JSON.parse(p.video_info) : p.video_info);
        if (streamUrl) pending.push([p.video_id, streamUrl]);
      } catch (e) {}
    }
  }
};

// share_info.function_entries 里补充下载入口（没有才加）
const ensureDownloadEntry = (item) => {
  const entries = item?.share_info?.function_entries;
  if (Array.isArray(entries) && !entries.some((e) => e?.type === "video_download")) {
    entries.unshift({ type: "video_download" });
  }
};

const stripRedId = (node) => {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const v = node[i];
      if (v && typeof v === "object") stripRedId(v);
    }
    return;
  }
  delete node.red_id;
  for (const key in node) {
    const v = node[key];
    if (v && typeof v === "object") stripRedId(v);
  }
};

const fixComment = (c, pending) => {
  if (c?.comment_type === 3) c.comment_type = 2;
  if (c?.media_source_type === 1) c.media_source_type = 0;
  collectCommentMedia(c, pending);
  for (const sc of c?.sub_comments || []) fixComment(sc, pending);
};

const main = () => {
  const url = $request.url;
  const body = $response.body;
  let obj = null;
  if (body) {
    try {
      obj = JSON.parse(body);
    } catch (e) {}
  }
  if (obj == null) return $done(body ? { body } : {});
  const data = obj.data;

  if (url.includes("/note/imagefeed") || url.includes("/note/feed")) {
    // 图文笔记：解除保存限制、关闭水印，缓存实况照片与视频流地址
    const livePending = [];
    const videoPending = [];
    for (const block of Array.isArray(data) ? data : data ? [data] : []) {
      if (!Array.isArray(block?.note_list)) continue;
      for (const item of block.note_list) {
        const media = item?.video_info_v2?.media;
        const isVideo = !!media || item?.type === "video";
        unlockSave(item, isVideo ? ["image_download", "video_download"] : ["image_download"]);
        if (isVideo) ensureDownloadEntry(item);
        for (const img of item.images_list || []) {
          if (!img?.live_photo_file_id) continue;
          const streamUrl = bestMediaUrl(img.live_photo?.media);
          if (streamUrl) livePending.push([img.live_photo_file_id, streamUrl]);
        }
        const streamUrl = item.id && bestMediaUrl(media);
        if (streamUrl) videoPending.push([item.id, streamUrl]);
      }
    }
    saveUrls(LP_PREFIX, LP_INDEX_KEY, LP_MAX, livePending);
    saveUrls(VID_PREFIX, VID_INDEX_KEY, VID_MAX, videoPending);
  } else if (url.includes("/note/videofeed")) {
    // 视频笔记信息流：解除限制、补下载入口、按 note_id 缓存最优流
    const pending = [];
    for (const item of Array.isArray(data) ? data : []) {
      unlockSave(item, ["video_download"]);
      ensureDownloadEntry(item);
      const streamUrl = item.id && bestMediaUrl(item.video_info_v2?.media);
      if (streamUrl) pending.push([item.id, streamUrl]);
    }
    saveUrls(VID_PREFIX, VID_INDEX_KEY, VID_MAX, pending);
  } else if (url.includes("/note/live_photo/save")) {
    // 实况照片保存：仅按 file_id 命中当前响应的条目才重写，其余原样放行
    if (Array.isArray(data?.datas)) {
      data.datas = data.datas.map((d) => {
        const streamUrl = d?.file_id ? getStoredUrl(LP_PREFIX, d.file_id) : null;
        return streamUrl ? { ...d, url: streamUrl } : d;
      });
    }
  } else if (url.includes("/note/video/save")) {
    // 视频保存：按 note_id 命中缓存则重写下载地址，并解除下载限制
    if (data) {
      const streamUrl = data.note_id ? getStoredUrl(VID_PREFIX, data.note_id) : null;
      if (streamUrl) data.download_url = streamUrl;
      if (data.disable) {
        delete data.disable;
        delete data.msg;
        data.status = 2;
      }
    }
  } else if (url.includes("/note/comment/list") || url.includes("/note/comment/sub_comments")) {
    // 评论区：贴纸类评论转图片类型可保存，递归剥离水印里的 red_id
    if (typeof obj === "object") stripRedId(obj);
    const pending = [];
    for (const c of data?.comments || []) fixComment(c, pending);
    for (const c of data?.sub_comments || []) fixComment(c, pending);
    saveUrls(CM_PREFIX, CM_INDEX_KEY, CM_MAX, pending);
  } else if (url.includes("/interaction/comment/video/download")) {
    // 评论区媒体下载：按 video_id 命中缓存重写 video_url
    const video = data?.video;
    const streamUrl = video?.video_id && getStoredUrl(CM_PREFIX, video.video_id);
    if (streamUrl) video.video_url = streamUrl;
  }

  $done({ body: JSON.stringify(obj) });
};

main();
