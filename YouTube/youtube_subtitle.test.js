/*
 * youtube_subtitle.js 的桩测试：用 vm 沙箱喂入假的 $request/$response/
 * $httpClient/$persistentStore，断言回写格式、超时兜底与缓存行为。
 * 运行：node YouTube/youtube_subtitle.test.js
 */
const fs=require('fs'),vm=require('vm');
const SRC=fs.readFileSync(require('path').join(__dirname,'youtube_subtitle.js'),'utf8');
let pass=0,fail=0;
const ok=(n,c)=>{c?(pass++,console.log('  ok  '+n)):(fail++,console.log('  FAIL '+n));};

function run({url,body,headers=undefined,store={},post,fastTimers=false,onWrite}){
  return new Promise(res=>{
    const s=Object.assign({'youtube_subtitle.api_key':'k'},store);
    const ctx={console,JSON,Math,Date,Object,Array,Map,Set,String,Number,Promise,RegExp,Error,parseInt,isNaN,
      $request:{url},$response:{body,headers},
      $persistentStore:{read:k=>s[k],write:(v,k)=>{s[k]=v;if(onWrite)onWrite(k,v);return true;}},
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

// 25 个 cue（>CHUNK_LINES=20）→ 2 个分块；每个分块完成即应有一次缓存写入，
// 加末尾终写共 3 次——脚本被中途掐断时已翻进度也已落盘
console.log('增量落盘');
const BIG='<timedtext><body>'+Array.from({length:25},(_,i)=>`<p t="${i}" d="1">line${i}</p>`).join('')+'</body></timedtext>';
let writes=0,firstWriteLines=[];
let bigCalls=0;
const bigPost=(o,cb)=>{const i=++bigCalls;const lines=JSON.parse(JSON.parse(o.body).messages[1].content);
  // 第 1 块延迟最大，保证第 2 块先完成——首写若已含它，证明是增量落盘
  setTimeout(()=>cb(null,{status:200},JSON.stringify({choices:[{message:{content:JSON.stringify({translations:lines.map(l=>'T:'+l)})}}]})),i===1?20:1);};
r=await run({url:U,body:BIG,post:bigPost,onWrite:(k,v)=>{
  if(k==='youtube_subtitle.cache.data'){writes++;
    if(writes===1)firstWriteLines=(v.match(/"line\d+"/g)||[]);}}});
ok('每个分块完成即写缓存', writes===3);
ok('首写在第 1 块完成前已落盘（含 line20 不含 line0）',
  firstWriteLines.includes('"line20"') && !firstWriteLines.includes('"line0"'));

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

console.log('谷歌翻译');
const googleStore={'youtube_subtitle.provider':'google','youtube_subtitle.api_key':''};
const googleRequests=[];
const gpost=sink=>(o,cb)=>{if(sink) sink.push(o);
  const qs=(o.body||'').split('&').filter(Boolean).map(x=>decodeURIComponent(x.slice(2)));
  setTimeout(()=>cb(null,{status:200},JSON.stringify(qs.map(x=>'译'+x))),1);};
r=await run({url:U,body:SRV3,store:googleStore,post:gpost(googleRequests)});
const googleRequest=googleRequests[0]||{};
const googleUrl=googleRequest.url||'';
const googleParams=new URLSearchParams(googleUrl.split('?')[1]||'');
const googleBody=googleRequest.body||'';
const googleQs=googleBody.split('&').filter(Boolean);
const googleHeaders=googleRequest.headers||{};
const googleHeader=name=>Object.keys(googleHeaders).find(k=>k.toLowerCase()===name.toLowerCase());
ok('谷歌无 key 仍产出双语', r.out.body.includes('>Hello\n译Hello<') && r.out.body.includes('>Are you ok?\n译Are you ok?<'));
ok('谷歌请求指向 translate_a/t', googleUrl.startsWith('https://translate.googleapis.com/translate_a/t?'));
ok('谷歌请求包含 client=gtx', googleParams.get('client')==='gtx');
ok('谷歌请求只带实测过的最小参数', [...googleParams.keys()].sort().join(',')==='client,sl,tl');
ok('默认简体中文映射为 zh-CN', googleParams.get('tl')==='zh-CN');
ok('字幕语言 lang=en 映射为 sl=en', googleParams.get('sl')==='en');
ok('谷歌请求使用 q 表单而非 JSON', googleQs.every(x=>x.startsWith('q=')) && googleQs.length>0 && !googleBody.startsWith('{'));
ok('q 数量等于非空字幕行数', googleQs.length===2);
ok('q 值经过 encodeURIComponent 编码', googleQs.includes('q=Are%20you%20ok%3F'));
ok('谷歌请求使用表单 Content-Type', googleHeaders[googleHeader('Content-Type')]==='application/x-www-form-urlencoded');
ok('谷歌请求携带 User-Agent', !!googleHeaders[googleHeader('User-Agent')]);
ok('谷歌请求不带 Authorization', !googleHeader('Authorization'));

const googleJa=[];
r=await run({url:U,body:SRV3,store:{...googleStore,'youtube_subtitle.target_lang':'繁体中文','youtube_subtitle.target_code':'ja'},post:gpost(googleJa)});
ok('显式 target_code 优先于语言名映射', new URLSearchParams((googleJa[0]?.url||'').split('?')[1]||'').get('tl')==='ja');
const googleTraditional=[];
r=await run({url:U,body:SRV3,store:{...googleStore,'youtube_subtitle.target_lang':'繁体中文'},post:gpost(googleTraditional)});
ok('繁体中文映射为 zh-TW', new URLSearchParams((googleTraditional[0]?.url||'').split('?')[1]||'').get('tl')==='zh-TW');
const googleUnknown=[];
r=await run({url:U,body:SRV3,store:{...googleStore,'youtube_subtitle.target_lang':'克林贡语'},post:gpost(googleUnknown)});
ok('未知目标语言退回 zh-CN', new URLSearchParams((googleUnknown[0]?.url||'').split('?')[1]||'').get('tl')==='zh-CN');

r=await run({url:U,body:SRV3,store:googleStore,post:(o,cb)=>{
  const qs=(o.body||'').split('&').filter(Boolean);
  setTimeout(()=>cb(null,{status:200},JSON.stringify(qs.slice(0,-1).map(()=>'译'))),1);
}});
ok('谷歌译文数组长度不符时回退原文', r.out.body===SRV3);
r=await run({url:U,body:SRV3,store:googleStore,post:(o,cb)=>setTimeout(()=>cb(null,{status:200},'not JSON'),1)});
ok('谷歌响应非法 JSON 时回退原文', r.out.body===SRV3);

// sl=auto 时每项是 [译文, 识别出的源语言]
r=await run({url:'https://www.youtube.com/api/timedtext?v=x&fmt=srv3',body:SRV3,
  store:{'youtube_subtitle.provider':'google','youtube_subtitle.api_key':''},
  post:(o,cb)=>{const qs=(o.body||'').split('&').filter(Boolean).map(x=>decodeURIComponent(x.slice(2)));
    setTimeout(()=>cb(null,{status:200},JSON.stringify(qs.map(x=>['译'+x,'en']))),1);}});
ok('谷歌 sl=auto 数组形态取首元素', r.out.body.includes('>Hello\n译Hello<'));

// 实测大批次出现过非空输入拿回空译文；放过去会把空译文写进缓存
const gstore={'youtube_subtitle.provider':'google','youtube_subtitle.api_key':''};
r=await run({url:U+'&fmt=srv3',body:SRV3,store:gstore,
  post:(o,cb)=>{const qs=(o.body||'').split('&').filter(Boolean).map(x=>decodeURIComponent(x.slice(2)));
    setTimeout(()=>cb(null,{status:200},JSON.stringify(qs.map((x,i)=>i===0?'':'译'+x))),1);}});
ok('谷歌空译文整批判失败回退原文', r.out.body===SRV3);
let regot=0;
r=await run({url:U+'&fmt=srv3',body:SRV3,store:r.store,
  post:(o,cb)=>{regot++;const qs=(o.body||'').split('&').filter(Boolean).map(x=>decodeURIComponent(x.slice(2)));
    setTimeout(()=>cb(null,{status:200},JSON.stringify(qs.map(x=>'译'+x))),1);}});
ok('空译文未被写进缓存，下次重译', regot>0 && r.out.body.includes('译Hello'));
r=await run({url:U,body:SRV3,store:{'youtube_subtitle.provider':'deepseek','youtube_subtitle.api_key':''},post:reply(l=>'译'+l)});
ok('DeepSeek 无 key 仍放行原文', r.out.body===SRV3);

console.log('注入健壮性');
// 译文来自外部服务，XML 1.0 禁止的控制字符会让整份字幕变成非法 XML
r=await run({url:U,body:'<timedtext><body><p t="0" d="9">Hi</p></body></timedtext>',
  post:reply(l=>'\u0000\u000b译'+l+'\u001f')});
ok('译文控制字符被剥离', r.out.body.includes('>Hi\n译Hi<'));
ok('输出不含禁止控制字符', !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(r.out.body));

// 数字实体解码后也可能凭空产生控制字符
r=await run({url:U,body:'<timedtext><body><p t="0" d="9">a&#11;b</p></body></timedtext>',
  post:reply(l=>'T')});
ok('原文侧控制字符同样被剥离', !/[\u000B]/.test(r.out.body));

// 自闭合 <p/> 原来会被正则一路吃到下一个 </p>，把两条 cue 揉成一条
const SELFCLOSE='<timedtext><body><p t="0" d="5"/><p t="10" d="9">Hi</p></body></timedtext>';
r=await run({url:U,body:SELFCLOSE,post:reply(l=>'译'+l)});
ok('自闭合 cue 原样保留', r.out.body.includes('<p t="0" d="5"/>'));
ok('自闭合后的 cue 正常翻译', r.out.body.includes('>Hi\n译Hi<'));
ok('标签配对未被破坏', (r.out.body.match(/<p\b/g)||[]).length===2 && (r.out.body.match(/<\/p>/g)||[]).length===1);

// json3 的 aAppend 与 xml 的 a="1" 必须同策略
const APPEND_JSON=JSON.stringify({events:[
  {tStartMs:0,dDurationMs:900,segs:[{utf8:'Hi'}]},
  {tStartMs:900,dDurationMs:100,aAppend:1,segs:[{utf8:'carry'}]}
]});
r=await run({url:'https://www.youtube.com/api/timedtext?v=x&lang=en&fmt=json3',body:APPEND_JSON,post:reply(l=>'译'+l)});
const aj=JSON.parse(r.out.body).events;
ok('json3 普通 event 仍翻译', aj[0].segs[0].utf8==='Hi\n译Hi');
ok('json3 非空 aAppend event 不翻译', aj[1].segs[0].utf8==='carry' && aj[1].aAppend===1);

// 谷歌的实际目标语言由 target_code 决定，不进缓存键会串用上一个语言的译文
const gbase={'youtube_subtitle.provider':'google','youtube_subtitle.api_key':''};
const gp=(pre)=>(o,cb)=>{const qs=(o.body||'').split('&').filter(Boolean).map(x=>decodeURIComponent(x.slice(2)));
  setTimeout(()=>cb(null,{status:200},JSON.stringify(qs.map(x=>pre+x))),1);};
r=await run({url:U+'&fmt=srv3',body:SRV3,store:Object.assign({},gbase,{'youtube_subtitle.target_code':'ja'}),post:gp('JA:')});
ok('谷歌首个语言代码产出译文', r.out.body.includes('JA:Hello'));
r=await run({url:U+'&fmt=srv3',body:SRV3,store:Object.assign({},r.store,{'youtube_subtitle.target_code':'ko'}),post:gp('KO:')});
ok('换目标语言代码不命中旧缓存', r.out.body.includes('KO:Hello') && !r.out.body.includes('JA:Hello'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
})();
