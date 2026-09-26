/*
 * 小红书去广告（Surge http-response 脚本）
 * - 开屏：splash_config 的广告组投放时间改到远期，客户端不再展示；config 去掉开屏/加载图
 * - 首页/关注/搜索信息流：剔除 is_ads / ads_info / model_type=ads 等推广条目
 * - 笔记挂件：去掉带货卡片、商业合作标注等推广组件
 * 笔记详情（imagefeed/videofeed）由去水印模块的脚本处理，本脚本不接管。
 */

// 2090-12-31，远大于任何真实投放窗口
const FAR_FUTURE = 3818332800;

const isAd = (item) => {
  if (!item || typeof item !== "object") return false;
  if (item.is_ads === true || item.ads_info || item.ad_info) return true;
  if (item.model_type === "ads" || item.model_type === "ad") return true;
  const note = item.note || item.note_card;
  return !!(note && (note.is_ads === true || note.ads_info));
};

const filterAds = (list) => (Array.isArray(list) ? list.filter((i) => !isAd(i)) : list);

const pushSplashAway = (groups) => {
  if (!Array.isArray(groups)) return;
  for (const g of groups) {
    if (!g || typeof g !== "object") continue;
    g.start_time = FAR_FUTURE;
    g.end_time = FAR_FUTURE + 86399;
    for (const ad of g.ads || []) {
      if (!ad || typeof ad !== "object") continue;
      ad.start_time = FAR_FUTURE;
      ad.end_time = FAR_FUTURE + 86399;
    }
  }
};

const deleteKeys = (data, keys) => {
  for (const key of keys) delete data[key];
};

const filterItems = (data) => {
  if (Array.isArray(data.items)) data.items = filterAds(data.items);
};

const WIDGET_AD_KEYS = ["goods_card_v2", "goods_card", "cooperate_binds", "cooperate_comment_component", "note_next_step"];

// 按顺序匹配，splash_config 必须排在 config 之前；handler 返回新的 data 时替换原值
const ROUTES = [
  ["/system_service/splash_config", (data) => {
    pushSplashAway(data.ads_groups);
    pushSplashAway(data.splash_groups);
  }],
  ["/system_service/config", (data) => deleteKeys(data, ["splash", "loading_img"])],
  ["/homefeed", (data) => (Array.isArray(data) ? filterAds(data) : filterItems(data))],
  ["/followfeed", filterItems],
  ["/search/notes", filterItems],
  ["/note/widgets", (data) => deleteKeys(data, WIDGET_AD_KEYS)],
];

const parseBody = (body) => {
  try {
    return JSON.parse(body);
  } catch (e) {
    return null;
  }
};

const main = () => {
  const url = $request.url;
  const route = ROUTES.find(([path]) => url.includes(path));
  const obj = route && parseBody($response.body);
  if (!obj?.data || typeof obj.data !== "object") return $done({});
  try {
    const next = route[1](obj.data);
    if (next !== undefined) obj.data = next;
    $done({ body: JSON.stringify(obj) });
  } catch (e) {
    console.log(`[小红书去广告] ${url} 处理失败: ${e}`);
    $done({});
  }
};

main();
