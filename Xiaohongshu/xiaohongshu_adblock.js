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

const rewrite = (url, obj) => {
  const data = obj?.data;
  if (!data) return;

  if (url.includes("/system_service/splash_config")) {
    pushSplashAway(data.ads_groups);
    pushSplashAway(data.splash_groups);
  } else if (url.includes("/system_service/config")) {
    for (const key of ["splash", "loading_img"]) delete data[key];
  } else if (url.includes("/homefeed")) {
    if (Array.isArray(data)) obj.data = filterAds(data);
    else data.items = filterAds(data.items);
  } else if (url.includes("/followfeed")) {
    data.items = filterAds(data.items);
  } else if (url.includes("/search/notes")) {
    data.items = filterAds(data.items);
  } else if (url.includes("/note/widgets")) {
    for (const key of ["goods_card_v2", "goods_card", "cooperate_binds", "cooperate_comment_component", "note_next_step"]) {
      delete data[key];
    }
  }
};

const url = $request.url;
let obj;
try {
  obj = JSON.parse($response.body);
} catch (e) {
  obj = null;
}

if (!obj) {
  $done({});
} else {
  try {
    rewrite(url, obj);
    $done({ body: JSON.stringify(obj) });
  } catch (e) {
    console.log(`[小红书去广告] ${url} 处理失败: ${e}`);
    $done({});
  }
}
