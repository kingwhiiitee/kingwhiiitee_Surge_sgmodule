/*
 * 小红书图片/视频去水印（Surge http-response 脚本）
 * - 图文笔记：关闭 media_save_config 的保存限制与水印，放行 image_download 开关
 * - 视频笔记：同上并放行 video_download 入口，按 note_id 缓存最优流地址
 * - 实况照片/视频保存：用缓存的无水印流地址重写 save 响应中的下载地址
 * - 评论区：贴纸类评论转图片类型（可保存），剥离水印中携带的 red_id
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

const newGen = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

// entries: [[id, streamUrl], ...]
const saveUrls = (keyPrefix, indexKey, maxEntries, entries) => {
  const fresh = [];
  const seen = new Set();
  for (const [id, streamUrl] of entries) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const g = newGen();
    writeStore(keyPrefix + id, JSON.stringify({ g, url: streamUrl }));
    fresh.push({ id, g });
  }
  if (!fresh.length) return;

  let index = [];
  try {
    const parsed = JSON.parse(readStore(indexKey));
    if (Array.isArray(parsed)) index = parsed;
  } catch (e) {}
  const entryId = (e) => (typeof e === "string" ? e : e?.id) || null;
  const freshIds = new Set(fresh.map((e) => e.id));
  index = index.filter((e) => entryId(e) && !freshIds.has(entryId(e))).concat(fresh);
  const evicted = index.splice(0, Math.max(0, index.length - maxEntries));
  for (const e of evicted) {
    const id = entryId(e);
    if (!id) continue;
    // 仅淘汰带 generation 且回读校验一致的条目；旧版索引项不删值，
    // 容忍孤儿键，避免 "读-校验-删" 窗口误删并发刷新的值
    const wantGen = typeof e === "object" && e ? e.g : undefined;
    if (wantGen == null) continue;
    try {
      const cur = JSON.parse(readStore(keyPrefix + id));
      if (cur && typeof cur === "object" && cur.g === wantGen) {
        writeStore(keyPrefix + id, null);
      }
    } catch (err) {}
  }
  writeStore(indexKey, JSON.stringify(index));
};

const getStoredUrl = (keyPrefix, id) => {
  const raw = readStore(keyPrefix + id);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v.url === "string" && v.url ? v.url : null;
  } catch (e) {
    return typeof raw === "string" ? raw : null;
  }
};

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

const bestMediaUrl = (media) =>
  media ? pickStreamUrl(media?.stream?.h265) || pickStreamUrl(media?.stream?.h264) : null;

// 关闭保存限制与水印；function_switch 里指定类型的开关放行
const unlockSave = (item, switchTypes) => {
  item.media_save_config = {
    ...(item.media_save_config || {}),
    disable_save: false,
    disable_watermark: true,
    disable_weibo_cover: true,
  };
  if (Array.isArray(item.function_switch)) {
    for (const sw of item.function_switch) {
      if (switchTypes.includes(sw?.type)) {
        sw.enable = true;
        if (sw.reason) delete sw.reason;
      }
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

const url = $request.url;
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
  $done(body ? { body } : {});
} else {
  // 图文笔记：解除保存限制、关闭水印，缓存实况照片与视频流地址
  if (url.includes("/note/imagefeed") || url.includes("/note/feed")) {
    const blocks = Array.isArray(obj?.data) ? obj.data : obj?.data ? [obj.data] : [];
    const livePending = [];
    const videoPending = [];
    for (const block of blocks) {
      if (!Array.isArray(block?.note_list)) continue;
      for (const item of block.note_list) {
        const isVideo = !!(item?.video_info_v2?.media) || item?.type === "video";
        unlockSave(item, isVideo ? ["image_download", "video_download"] : ["image_download"]);
        if (isVideo) ensureDownloadEntry(item);
        for (const img of item.images_list || []) {
          if (!img?.live_photo_file_id) continue;
          const streamUrl = bestMediaUrl(img?.live_photo?.media);
          if (streamUrl) livePending.push([img.live_photo_file_id, streamUrl]);
        }
        if (item?.id) {
          const streamUrl = bestMediaUrl(item?.video_info_v2?.media);
          if (streamUrl) videoPending.push([item.id, streamUrl]);
        }
      }
    }
    if (livePending.length) saveUrls(LP_PREFIX, LP_INDEX_KEY, LP_MAX, livePending);
    if (videoPending.length) saveUrls(VID_PREFIX, VID_INDEX_KEY, VID_MAX, videoPending);
  }

  // 视频笔记信息流：解除限制、补下载入口、按 note_id 缓存最优流
  if (url.includes("/note/videofeed")) {
    const items = Array.isArray(obj?.data) ? obj.data : [];
    const pending = [];
    for (const item of items) {
      unlockSave(item, ["video_download"]);
      ensureDownloadEntry(item);
      if (item?.id) {
        const streamUrl = bestMediaUrl(item?.video_info_v2?.media);
        if (streamUrl) pending.push([item.id, streamUrl]);
      }
    }
    if (pending.length) saveUrls(VID_PREFIX, VID_INDEX_KEY, VID_MAX, pending);
  }

  // 实况照片保存：仅按 file_id 命中当前响应的条目才重写，其余原样放行
  if (url.includes("/note/live_photo/save") && Array.isArray(obj?.data?.datas)) {
    obj.data.datas = obj.data.datas.map((d) => {
      const streamUrl = d?.file_id ? getStoredUrl(LP_PREFIX, d.file_id) : null;
      return streamUrl ? { ...d, url: streamUrl } : d;
    });
  }

  // 视频保存：按 note_id 命中缓存则重写下载地址，并解除下载限制
  if (url.includes("/note/video/save") && obj?.data) {
    const streamUrl = obj.data.note_id ? getStoredUrl(VID_PREFIX, obj.data.note_id) : null;
    if (streamUrl) obj.data.download_url = streamUrl;
    if (obj.data.disable) {
      delete obj.data.disable;
      delete obj.data.msg;
      obj.data.status = 2;
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
      for (const sc of c?.sub_comments || []) fixComment(sc);
    };
    stripRedId(obj);
    for (const c of [...(obj?.data?.comments || []), ...(obj?.data?.sub_comments || [])]) {
      fixComment(c);
    }
  }

  $done({ body: JSON.stringify(obj) });
}
