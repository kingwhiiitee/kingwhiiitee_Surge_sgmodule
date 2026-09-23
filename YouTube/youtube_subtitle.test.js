/*
 * youtube_subtitle.js 的桩测试：用 vm 沙箱喂入假的 $request/$response/
 * $httpClient/$persistentStore，断言回写格式、超时兜底与缓存行为。
 * 运行：node YouTube/youtube_subtitle.test.js
 */
const fs=require('fs'),vm=require('vm');
const SRC=fs.readFileSync(require('path').join(__dirname,'youtube_subtitle.js'),'utf8');
let pass=0,fail=0;
const ok=(n,c)=>{c?(pass++,console.log('  ok  '+n)):(fail++,console.log('  FAIL '+n));};

function run({url,body,headers=undefined,store={},post,fastTimers=false}){
  return new Promise(res=>{
    const s=Object.assign({'youtube_subtitle.api_key':'k'},store);
    const ctx={console,JSON,Math,Date,Object,Array,Map,Set,String,Number,Promise,RegExp,Error,parseInt,isNaN,
      $request:{url},$response:{body,headers},
      $persistentStore:{read:k=>s[k],write:(v,k)=>{s[k]=v;return true;}},
      $httpClient:{post},
      $done:r=>res({out:r,store:s}),
      // fastTimers 把时钟缩放 1000 倍，让 15s 超时在毫秒级内跑完
      setTimeout:(f,d)=>setTimeout(f,fastTimers?Math.max(0,d/1000):d),
      clearTimeout};
    ctx.globalThis=ctx;
    vm.runInNewContext(SRC,vm.createContext(ctx));
  });
}
const reply=map=>(o,cb)=>{const lines=JSON.parse(JSON.parse(o.body).messages[1].content);
  setTimeout(()=>cb(null,{status:200},JSON.stringify({choices:[{message:{content:JSON.stringify({translations:lines.map(l=>map(l))})}}]})),1);};
const hang=()=>{};

(async()=>{
const SRV3='<?xml version="1.0" encoding="utf-8"?><timedtext format="3"><body>'+
 '<p t="0" d="1000">Hello</p><p t="1000" d="1000"><s ac="1">Are</s><s t="10"> you ok?</s></p><p t="2000" d="500"> </p></body></timedtext>';
const U='https://www.youtube.com/api/timedtext?v=x&lang=en&fmt=srv3';

console.log('srv3 回写');
let r=await run({url:U,body:SRV3,post:reply(l=>'【'+l+'】')});
ok('含字面换行', /<p t="0" d="1000">Hello\n【Hello】<\/p>/.test(r.out.body));
ok('不含 &#x000A; 实体', !r.out.body.includes('&#x000A;'));
ok('karaoke <s> 拍平', r.out.body.includes('>Are you ok?\n【Are you ok?】<'));
ok('空白 cue 原样', r.out.body.includes('<p t="2000" d="500"> </p>'));
ok('XML 头与根保留', r.out.body.startsWith('<?xml') && r.out.body.endsWith('</timedtext>'));

console.log('自动字幕 kind=asr');
const ASR_SRV3='<?xml version="1.0" encoding="utf-8"?><timedtext format="3"><body>'+
 '<p t="0" d="1200" w="1"><s ac="0">Hello</s><s t="300" ac="0"> world</s></p>'+
 '<p t="1200" d="10" w="1" a="1"></p>'+
 '<p t="1300" d="800" w="1" a="1">carry over</p></body></timedtext>';
let asrCalls=0;
const asrPost=(o,cb)=>{asrCalls++;reply(l=>'译'+l)(o,cb);};
r=await run({url:U+'&kind=asr&fmt=srv3',body:ASR_SRV3,post:asrPost});
const asrCues=r.out.body.match(/<p\b[^>]*>[\s\S]*?<\/p>/g)||[];
const translatedCue=asrCues[0]||'';
ok('自动字幕普通 cue 双语', translatedCue.includes('>Hello world\n译Hello world<'));
ok('自动字幕空追加 cue 原样', r.out.body.includes('<p t="1200" d="10" w="1" a="1"></p>'));
ok('自动字幕文本追加 cue 原样', r.out.body.includes('<p t="1300" d="800" w="1" a="1">carry over</p>'));
ok('自动字幕追加 cue 不附译文', asrCues.length===3 && !asrCues[1].includes('译') && !asrCues[2].includes('译'));
ok('自动字幕译文 cue 保留起点', translatedCue.includes('t="0"'));
ok('自动字幕译文 cue 保留时长', translatedCue.includes('d="1200"'));
ok('自动字幕译文 cue 移除滚动窗口属性', !translatedCue.includes('w="'));
ok('自动字幕译文 cue 移除追加属性', !translatedCue.includes('a="'));
ok('自动字幕请求 LLM', asrCalls>0);

console.log('自动字幕 重叠时长收拢');
const OVERLAP='<timedtext format="3"><body>'+
 '<p t="1040" d="3360" w="1" ws="1" wp="1">welcome to chaos</p>'+
 '<p t="2710" d="1690" w="1" a="1"></p>'+
 '<p t="2720" d="2960" w="1">edition enjoy</p></body></timedtext>';
r=await run({url:U+'&kind=asr&fmt=srv3',body:OVERLAP,post:reply(l=>'译'+l)});
const oc=r.out.body.match(/<p\b[^>]*>[\s\S]*?<\/p>/g)||[];
ok('重叠 cue 时长收到下一条有文字 cue 起点', oc[0].includes('d="1680"'));
ok('收拢不改起点', oc[0].includes('t="1040"'));
ok('末条 cue 无后继则时长不变', oc[2].includes('d="2960"'));
ok('清除 ws 滚动样式引用', !oc[0].includes('ws="'));
ok('清除 wp 滚动位置引用', !oc[0].includes('wp="'));
ok('空追加 cue 不参与收拢判定', r.out.body.includes('<p t="2710" d="1690" w="1" a="1"></p>'));

const NOOVERLAP='<timedtext format="3"><body>'+
 '<p t="0" d="900">one</p><p t="1000" d="900">two</p></body></timedtext>';
r=await run({url:U,body:NOOVERLAP,post:reply(l=>'译'+l)});
ok('普通不重叠字幕时长不被改动', r.out.body.includes('d="900">one\n译one<') && r.out.body.includes('d="900">two\n译two<'));

console.log('自动字幕 json3');
const ASR_JSON=JSON.stringify({events:[
  {tStartMs:0,dDurationMs:1200,wWinId:1,wpWinPosId:2,wsWinStyleId:3,segs:[{utf8:'Hello'},{utf8:' world'}]},
  {aAppend:1,segs:[{utf8:'\n'}]}
],wpWinPositions:[{id:0}],wsWinStyles:[{id:0}]});
r=await run({url:'https://www.youtube.com/api/timedtext?v=x&lang=en&kind=asr&fmt=json3',body:ASR_JSON,post:asrPost});
const asrJson=JSON.parse(r.out.body);
const asrEvent=asrJson.events[0],asrAppend=asrJson.events[1];
ok('自动字幕 json3 普通 event 双语', asrEvent.segs[0].utf8==='Hello world\n译Hello world');
ok('自动字幕 json3 移除 wWinId', !('wWinId' in asrEvent));
ok('自动字幕 json3 移除 wpWinPosId', !('wpWinPosId' in asrEvent));
ok('自动字幕 json3 移除 wsWinStyleId', !('wsWinStyleId' in asrEvent));
ok('自动字幕 json3 保留顶层窗口定义表', Array.isArray(asrJson.wpWinPositions) && Array.isArray(asrJson.wsWinStyles));
ok('自动字幕 json3 追加 event 保留 aAppend', asrAppend.aAppend===1);
ok('自动字幕 json3 追加 event 保留原始 segs', asrAppend.segs.length===1 && asrAppend.segs[0].utf8==='\n');

const OVERLAP_JSON=JSON.stringify({events:[
  {tStartMs:80,dDurationMs:3440,wWinId:1,segs:[{utf8:'first'}]},
  {aAppend:1,segs:[{utf8:'\n'}]},
  {tStartMs:1880,dDurationMs:2000,wWinId:1,segs:[{utf8:'second'}]}
]});
r=await run({url:'https://www.youtube.com/api/timedtext?v=x&lang=en&kind=asr&fmt=json3',body:OVERLAP_JSON,post:reply(l=>'译'+l)});
const oj=JSON.parse(r.out.body).events;
ok('json3 重叠 event 时长收到下一条起点', oj[0].dDurationMs===1800);
ok('json3 收拢不改起点', oj[0].tStartMs===80);
ok('json3 末条 event 时长不变', oj[2].dDurationMs===2000);

console.log('position=above / only');
r=await run({url:U,body:SRV3,store:{'youtube_subtitle.position':'above'},post:reply(l=>'T:'+l)});
ok('above 译上原下', r.out.body.includes('>T:Hello\nHello<'));
r=await run({url:U,body:SRV3,store:{'youtube_subtitle.position':'only'},post:reply(l=>'T:'+l)});
ok('only 仅译文', r.out.body.includes('>T:Hello<') && !r.out.body.includes('>Hello\n'));

console.log('json3');
const J=JSON.stringify({events:[{tStartMs:0,dDurationMs:900,segs:[{utf8:'Hi'},{utf8:' there'}]},{segs:[{utf8:'  '}]}]});
r=await run({url:'https://www.youtube.com/api/timedtext?v=x&lang=en&fmt=json3',body:J,post:reply(l=>'译'+l)});
const jo=JSON.parse(r.out.body);
ok('json3 追加译文行', jo.events[0].segs[0].utf8==='Hi there\n译Hi there');
ok('json3 空白 event 原样', jo.events[1].segs.length===1 && jo.events[1].segs[0].utf8==='  ');

console.log('转义');
r=await run({url:U,body:'<timedtext><body><p t="0" d="9">a &amp; b &lt;x&gt;</p></body></timedtext>',post:reply(l=>l.toUpperCase())});
ok('原文重新转义', r.out.body.includes('>a &amp; b &lt;x&gt;\nA &amp; B &lt;X&gt;<'));

console.log('兜底超时');
let t0=Date.now();
r=await run({url:U,body:SRV3,post:hang,fastTimers:true});
ok('挂起连接不卡死，回退原文', r.out.body===SRV3);
ok('在 1s 内返回（时钟缩放后）', Date.now()-t0<1000);
let calls=0;
await run({url:U,body:SRV3,post:(o,cb)=>{calls++;},fastTimers:true});
ok('超时不重试（每批仅 1 次请求）', calls===1);

console.log('缓存');
const st={};
r=await run({url:U,body:SRV3,store:st,post:reply(l=>'C:'+l)});
let n=0;
r=await run({url:U,body:SRV3,store:r.store,post:(o,cb)=>{n++;reply(l=>'X')(o,cb);}});
ok('二次命中缓存不再请求', n===0 && r.out.body.includes('C:Hello'));

console.log('放行');
r=await run({url:U+'&tlang=zh',body:SRV3,post:reply(l=>'T')});
ok('tlang 原样放行', r.out.body===SRV3);
r=await run({url:U,body:SRV3,store:{'youtube_subtitle.api_key':''},post:reply(l=>'T')});
ok('无 key 原样放行', r.out.body===SRV3);
r=await run({url:'https://www.youtube.com/api/timedtext?v=x&fmt=vtt',body:'WEBVTT',post:reply(l=>'T')});
ok('vtt 不处理', r.out.body==='WEBVTT');

console.log('响应头清洗');
const originalHeaders={'Content-Length':'123','Content-Encoding':'gzip','Content-Type':'application/xml','X-Keep':'1'};
r=await run({url:U,body:SRV3,headers:originalHeaders,post:reply(l=>'H:'+l)});
const cleanedKeys=Object.keys(r.out.headers||{}).map(k=>k.toLowerCase());
ok('翻译后回写响应头', !!r.out.headers);
ok('移除 Content-Length', !cleanedKeys.includes('content-length'));
ok('移除 Content-Encoding', !cleanedKeys.includes('content-encoding'));
ok('保留 Content-Type', r.out.headers && r.out.headers['Content-Type']==='application/xml');
ok('保留 X-Keep', r.out.headers && r.out.headers['X-Keep']==='1');
r=await run({url:U,body:SRV3,headers:{'content-length':'123','content-encoding':'br'},post:reply(l=>'H:'+l)});
const lowerKeys=Object.keys(r.out.headers||{}).map(k=>k.toLowerCase());
ok('小写 content-length 也被移除', !!r.out.headers && !lowerKeys.includes('content-length'));
ok('小写 content-encoding 也被移除', !!r.out.headers && !lowerKeys.includes('content-encoding'));
r=await run({url:U,body:SRV3,post:reply(l=>'H:'+l)});
ok('缺少响应头仍回写双语 body', 'body' in r.out && r.out.body.includes('>Hello\nH:Hello<'));
r=await run({url:U,body:SRV3,headers:originalHeaders,store:{'youtube_subtitle.api_key':''},post:reply(l=>'H:'+l)});
const passKeys=Object.keys(r.out.headers||{}).map(k=>k.toLowerCase());
ok('放行时回写原始 body', r.out.body===SRV3);
ok('放行时也清洗响应头', !!r.out.headers && !passKeys.includes('content-length') && !passKeys.includes('content-encoding'));

console.log('运行模式');
let offCalls=0;
r=await run({url:U,body:SRV3,headers:originalHeaders,store:{'youtube_subtitle.mode':'off'},post:()=>{offCalls++;}});
ok('off 不回写 body', !('body' in r.out));
ok('off 不回写 headers', !('headers' in r.out));
ok('off 不调用翻译接口', offCalls===0);
let headersCalls=0;
r=await run({url:U,body:SRV3,headers:originalHeaders,store:{'youtube_subtitle.mode':'headers'},post:()=>{headersCalls++;}});
const headersModeKeys=Object.keys(r.out.headers||{}).map(k=>k.toLowerCase());
ok('headers 返回原始 body', r.out.body===SRV3);
ok('headers 清洗响应头', !!r.out.headers && !headersModeKeys.includes('content-length') && !headersModeKeys.includes('content-encoding'));
ok('headers 不调用翻译接口', headersCalls===0);
let passthroughCalls=0;
r=await run({url:U,body:SRV3,store:{'youtube_subtitle.mode':'passthrough'},post:(o,cb)=>{passthroughCalls++;reply(l=>'P:'+l)(o,cb);}});
ok('passthrough 返回原始 body', r.out.body===SRV3);
ok('passthrough 仍调用翻译接口', passthroughCalls>0);
const passthroughStore=r.store;
passthroughStore['youtube_subtitle.mode']='on';
r=await run({url:U,body:SRV3,store:passthroughStore,post:reply(l=>'N:'+l)});
ok('passthrough 后切回 on 仍产出双语', /<p t="0" d="1000">Hello\n[PN]:Hello<\/p>/.test(r.out.body));
r=await run({url:U,body:SRV3,store:{},post:reply(l=>'D:'+l)});
ok('未设置 mode 默认产出双语', r.out.body.includes('>Hello\nD:Hello<'));

console.log('翻译时限可配');
t0=Date.now();
r=await run({url:U,body:SRV3,store:{'youtube_subtitle.budget_ms':'3000'},post:hang,fastTimers:true});
ok('3000ms 时限快速回退原文', r.out.body===SRV3 && Date.now()-t0<1000);
r=await run({url:U,body:SRV3,store:{'youtube_subtitle.budget_ms':'abc'},post:reply(l=>'B:'+l)});
ok('非法时限回退默认值并正常翻译', r.out.body.includes('>Hello\nB:Hello<'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
})();
