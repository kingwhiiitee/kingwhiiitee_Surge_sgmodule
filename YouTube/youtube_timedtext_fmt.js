/*
 * YouTube 双语字幕模块的 Surge http-request 侧脚本。
 * 将 timedtext 字幕格式统一钉成 json3，让响应侧只处理结构化 JSON，
 * 避免 srv3 的滚动窗口和标签拍平问题。
 * BoxJS 的 youtube_subtitle.force_json3 可关闭此功能，默认开启。
 * 关闭或改写失败时原样放行，不影响原始字幕。
 */

const readKey = (n, dft) => {
  const v = $persistentStore.read(`youtube_subtitle.${n}`);
  return v === undefined || v === null || v === "" ? dft : v;
};
const log = (m) => console.log(`[yt-fmt] ${m}`);

const forceJson3 = (url) => {
  if (/[?&]fmt=json3(?:&|$)/.test(url)) return url;
  if (/[?&]fmt=/.test(url)) return url.replace(/([?&])fmt=[^&]*/, "$1fmt=json3");
  return `${url}${url.includes("?") ? "&" : "?"}fmt=json3`;
};

if (typeof $done === "function") {
  // 请求侧出错也必须放行原请求，不能让字幕加载失败。
  try {
    const enabled = String(readKey("force_json3", "true")) !== "false";
    const url = ($request && $request.url) || "";

    if (!enabled) {
      log("disabled, pass through");
      $done({});
    } else if (/[?&]tlang(?:=|&|$)/.test(url)) {
      log("tlang, pass through");
      $done({});
    } else if (/[?&]fmt=json3(?:&|$)/.test(url)) {
      log("fmt=json3, pass through");
      $done({});
    } else {
      const newUrl = forceJson3(url);
      log("fmt -> json3");
      $done({ url: newUrl });
    }
  } catch (e) {
    log("fatal " + e);
    $done({});
  }
}

if (typeof module !== "undefined" && module.exports) module.exports = { forceJson3 };
