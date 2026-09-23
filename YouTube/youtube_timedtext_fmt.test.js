/* youtube_timedtext_fmt.js 的桩测试：用 vm 沙箱验证 URL 改写与请求放行。 */
const fs=require('fs'),vm=require('vm');
const SRC=fs.readFileSync(require('path').join(__dirname,'youtube_timedtext_fmt.js'),'utf8');
let pass=0,fail=0;
const ok=(n,c)=>{c?(pass++,console.log('  ok  '+n)):(fail++,console.log('  FAIL '+n));};
const emptyDone=r=>r && typeof r==='object' && !('url' in r) && Object.keys(r).length===0;
const calledDone=r=>r && !('__uncaught' in r) && !('__missingDone' in r);

function run({url,store={},missingRequest=false,readError=false}={}){
  return new Promise(resolve=>{
    const timer=setTimeout(()=>resolve({__missingDone:true}),100);
    const ctx={console,URL,URLSearchParams,
      $persistentStore:{read:k=>{if(readError) throw new Error('读取配置失败');return store[k];}},
      $done:r=>{clearTimeout(timer);resolve(r);}};
    if(!missingRequest) ctx.$request={url};
    ctx.globalThis=ctx;
    try{vm.runInNewContext(SRC,ctx);}catch(e){clearTimeout(timer);resolve({__uncaught:e});}
  });
}

(async()=>{
const BASE='https://www.youtube.com/api/timedtext';
const pureCtx={console,URL,URLSearchParams,
  $request:{url:BASE},$persistentStore:{read:()=>undefined},$done:()=>{},module:{exports:{}}};
pureCtx.globalThis=pureCtx;
vm.runInNewContext(SRC,pureCtx);
const forceJson3=pureCtx.module.exports.forceJson3;

console.log('forceJson3 URL 变换');
ok('无查询串时追加 fmt',forceJson3(BASE)===BASE+'?fmt=json3');
ok('已有查询串时追加 fmt',forceJson3(BASE+'?v=x&lang=en')===BASE+'?v=x&lang=en&fmt=json3');
ok('srv3 改为 json3 且保留其他参数顺序',forceJson3(BASE+'?v=x&lang=en&fmt=srv3')===BASE+'?v=x&lang=en&fmt=json3');
ok('vtt 改为 json3',forceJson3(BASE+'?fmt=vtt')===BASE+'?fmt=json3');
ok('中间的 fmt 替换后保留前后参数',forceJson3(BASE+'?v=x&fmt=srv3&lang=en')===BASE+'?v=x&fmt=json3&lang=en');
ok('末尾的 fmt 正确替换',forceJson3(BASE+'?v=x&fmt=srv3')===BASE+'?v=x&fmt=json3');
ok('已有 json3 时 URL 不变',forceJson3(BASE+'?v=x&fmt=json3')===BASE+'?v=x&fmt=json3');
ok('xfmt 不被误改且追加独立 fmt',forceJson3(BASE+'?v=x&xfmt=srv3')===BASE+'?v=x&xfmt=srv3&fmt=json3');

console.log('请求脚本行为');
let r=await run({url:BASE+'?v=x&fmt=srv3'});
ok('默认配置改写 srv3 请求',r && r.url===BASE+'?v=x&fmt=json3');
r=await run({url:BASE+'?fmt=srv3',store:{'youtube_subtitle.force_json3':'false'}});
ok('配置为 false 时空对象放行',emptyDone(r));
r=await run({url:BASE+'?fmt=srv3',store:{'youtube_subtitle.force_json3':'true'}});
ok('配置为 true 时改写请求',r && r.url===BASE+'?fmt=json3');
r=await run({url:BASE+'?fmt=srv3&tlang=zh-Hans'});
ok('自动翻译请求空对象放行',emptyDone(r));
r=await run({url:BASE+'?fmt=json3'});
ok('已有 json3 时空对象放行',emptyDone(r));
r=await run({missingRequest:true});
ok('缺少 request 时捕获异常并调用 done',calledDone(r));
r=await run({url:''});
ok('空 URL 时调用 done',calledDone(r));
r=await run({url:BASE+'?fmt=srv3',readError:true});
ok('读取配置异常时调用 done 放行',calledDone(r) && emptyDone(r));

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
})();
