/* xiaohongshu_adblock.js 的桩测试：用 vm 沙箱验证各路由的去广告改写与放行。 */
const fs = require("fs"), vm = require("vm");
const SRC = fs.readFileSync(require("path").join(__dirname, "xiaohongshu_adblock.js"), "utf8");
let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  ok  " + n)) : (fail++, console.log("  FAIL " + n)); };

const run = (url, body) => {
  let out;
  vm.runInNewContext(SRC, {
    console: { log() {} },
    $request: { url },
    $response: { body: typeof body === "string" ? body : JSON.stringify(body) },
    $done: (r) => { out = r; },
  });
  return out;
};
const data = (url, body) => JSON.parse(run(url, body).body).data;
const API = "https://edith.xiaohongshu.com/api/sns";

const home = data(`${API}/v6/homefeed?oid=1`, { data: [{ id: 1 }, { id: 2, is_ads: true }, { id: 3, ads_info: {} }] });
ok("首页数组剔除推广", home.length === 1 && home[0].id === 1);

const homeObj = data(`${API}/v6/homefeed`, { data: { items: [{ id: 1 }, { id: 2, model_type: "ads" }] } });
ok("首页对象 items 剔除推广", homeObj.items.length === 1);

const search = data(`${API}/v10/search/notes?k`, { data: { items: [{ model_type: "note" }, { model_type: "ads" }, { note: { is_ads: true } }] } });
ok("搜索剔除推广与内嵌广告笔记", search.items.length === 1);

const follow = data(`${API}/v4/followfeed`, { data: { cursor: "c" } });
ok("无 items 时不写入空字段", !("items" in follow) && follow.cursor === "c");

const splash = data(`${API}/v2/system_service/splash_config`, { data: { ads_groups: [{ start_time: 1, ads: [{ start_time: 1 }] }] } });
ok("开屏广告组推迟", splash.ads_groups[0].start_time > 3e9 && splash.ads_groups[0].ads[0].end_time > 3e9);

const config = data(`${API}/v1/system_service/config`, { data: { splash: 1, loading_img: 2, keep: 3 } });
ok("config 去掉开屏与加载图", !("splash" in config) && !("loading_img" in config) && config.keep === 3);

const widgets = data(`${API}/v1/note/widgets`, { data: { goods_card_v2: 1, cooperate_binds: 2, keep: 3 } });
ok("挂件去掉推广组件", Object.keys(widgets).join() === "keep");

ok("非 JSON 原样放行", Object.keys(run(`${API}/v6/homefeed`, "<html>")).length === 0);
ok("未匹配路由原样放行", Object.keys(run(`${API}/v1/other`, { data: {} })).length === 0);
ok("缺少 data 原样放行", Object.keys(run(`${API}/v6/homefeed`, { code: 0 })).length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
