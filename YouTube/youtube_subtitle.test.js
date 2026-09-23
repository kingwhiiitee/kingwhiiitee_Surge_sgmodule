/*
 * youtube_subtitle.js 的桩测试：用 vm 沙箱喂入假的 $request/$response/
 * $httpClient/$persistentStore，断言回写格式、超时兜底与缓存行为。
 * 运行：node YouTube/youtube_subtitle.test.js
 */
const fs=require('fs'),vm=require('vm');
const SRC=fs.readFileSync(require('path').join(__dirname,'youtube_subtitle.js'),'utf8');
let pass=0,fail=0;
const ok=(n,c)=>{c?(pass++,console.log('  ok  '+n)):(fail++,console.log('  FAIL '+n));};

function run({url,body,store={},post,fastTimers=false}){
  return new Promise(res=>{
    const s=Object.assign({'youtube_subtitle.api_key':'k'},store);
    const ctx={console,JSON,Math,Date,Object,Array,Map,Set,String,Number,Promise,RegExp,Error,parseInt,isNaN,
      $request:{url},$response:{body},
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
})();
