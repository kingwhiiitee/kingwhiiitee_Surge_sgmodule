/*
 * 小红书图片去水印（Surge http-response 脚本）
 * - 图文笔记：关闭 media_save_config 的保存限制与水印，放行 image_download 开关
 * - 实况照片：以笔记 feed 缓存中的无水印流地址替换 live_photo/save 返回
 * - 评论区：贴纸类评论转图片类型（可保存），剥离水印中携带的 red_id
 * 配合 [Map Local] 将水印配置图替换为 1px 透明图，客户端无法叠加水印。
 */

// 实况照片流地址按 live_photo_file_id 一键一值存储，不同 feed 响应写入互不覆盖；
// 索引键记录写入顺序用于淘汰最旧条目，索引更新竞态最多留下孤儿键，不会丢数据。
const LP_PREFIX = "kingwhiiitee.xhs.lp.";
const LP_INDEX_KEY = "kingwhiiitee.xhs.lp.idx";
const LP_MAX = 300;

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

// entries: [[live_photo_file_id, streamUrl], ...]
// 值与索引条目携带 generation，删除被淘汰键前回读校验 generation 一致，
// 避免并发响应把刚刷新的 URL 删掉；索引竞态最多留孤儿键，不会丢数据。
const saveLivePhotoUrls = (entries) => {
  const fresh = [];
  const seen = new Set();
  for (const [fileId, streamUrl] of entries) {
    if (seen.has(fileId)) continue;
    seen.add(fileId);
    const g = newGen();
    writeStore(LP_PREFIX + fileId, JSON.stringify({ g, url: streamUrl }));
    fresh.push({ id: fileId, g });
  }
  if (!fresh.length) return;

  let index = [];
  try {
    const parsed = JSON.parse(readStore(LP_INDEX_KEY));
    if (Array.isArray(parsed)) index = parsed;
  } catch (e) {}
  const entryId = (e) => (typeof e === "string" ? e : e?.id) || null;
  const freshIds = new Set(fresh.map((e) => e.id));
  index = index.filter((e) => entryId(e) && !freshIds.has(entryId(e))).concat(fresh);
  const evicted = index.splice(0, Math.max(0, index.length - LP_MAX));
  for (const e of evicted) {
    const id = entryId(e);
    if (!id) continue;
    const raw = readStore(LP_PREFIX + id);
    if (raw == null) continue;
    // 值与索引条目携带 generation 时，仅当一致才删除；旧版裸字符串值视为 "legacy"
    const wantGen = (typeof e === "object" && e ? e.g : undefined) ?? "legacy";
    try {
      const cur = JSON.parse(raw);
      const storedGen = cur && typeof cur === "object" ? cur.g : "legacy";
      if (storedGen === wantGen) writeStore(LP_PREFIX + id, null);
    } catch (err) {
      if (wantGen === "legacy") writeStore(LP_PREFIX + id, null);
    }
  }
  writeStore(LP_INDEX_KEY, JSON.stringify(index));
};

const getLivePhotoUrl = (fileId) => {
  const raw = readStore(LP_PREFIX + fileId);
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
  // 图文笔记：解除保存限制、关闭水印，并缓存实况照片流地址
  if (url.includes("/note/imagefeed") || url.includes("/note/feed")) {
    const blocks = Array.isArray(obj?.data) ? obj.data : obj?.data ? [obj.data] : [];
    const pending = [];
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
        for (const img of item.images_list || []) {
          if (!img?.live_photo_file_id) continue;
          const streamUrl =
            pickStreamUrl(img?.live_photo?.media?.stream?.h265) ||
            pickStreamUrl(img?.live_photo?.media?.stream?.h264);
          if (streamUrl) pending.push([img.live_photo_file_id, streamUrl]);
        }
      }
    }
    if (pending.length) saveLivePhotoUrls(pending);
  }

  // 实况照片保存：仅按 file_id 命中当前响应的条目才重写，其余原样放行
  if (url.includes("/note/live_photo/save") && Array.isArray(obj?.data?.datas)) {
    obj.data.datas = obj.data.datas.map((d) => {
      const streamUrl = d?.file_id ? getLivePhotoUrl(d.file_id) : null;
      return streamUrl ? { ...d, url: streamUrl } : d;
    });
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
