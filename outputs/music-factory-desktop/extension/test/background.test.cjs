const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const {webcrypto}=require('node:crypto');
function fixture(fetchHook) {
  const handlers={}, state={config:{accountId:'bos',token:'abc123def456ghij'},active:{
    job:{id:'j1',type:'publish',accountId:'bos',handle:'bos-423483424',tracks:[{id:'t1',title:'Song',filename:'Song.wav'}]},
    phase:'ready',tabId:42,lastSeen:Date.now(),sideEffect:false,results:[]},attempted:[]};
  const event=name=>({addListener:fn=>{handlers[name]=fn;}});
  const calls=[],removed=[],reloaded=[];
  const chrome={storage:{local:{get:async keys=>structuredClone(Object.fromEntries(keys.map(k=>[k,state[k]]))),set:async v=>Object.assign(state,structuredClone(v)),setAccessLevel:async()=>{}}},
    runtime:{id:'factory-test',getURL:p=>'chrome-extension://factory-test/'+p,getManifest:()=>({version:'2.2.3'}),onMessage:event('message'),onInstalled:event('install'),onStartup:event('startup')},
    alarms:{create:async()=>{},onAlarm:event('alarm')},
    tabs:{create:async p=>{calls.push(p);return{id:84};},query:async()=>[],update:async(id,p)=>{calls.push(p);},reload:async id=>{reloaded.push(id);},remove:async id=>{removed.push(id);},onRemoved:event('removed')},action:{setBadgeText:async()=>{}}};
  const ctx=vm.createContext({chrome,console,URL,AbortSignal,Uint8Array,Date,Set,Promise,crypto:webcrypto,btoa:v=>Buffer.from(v,'binary').toString('base64'),
    fetch:async(url,options)=>{if(fetchHook){const r=await fetchHook(url,options,state);if(r)return r;}return new Response(JSON.stringify(url.includes('/bridge/job')?null:{}),{headers:{'Content-Type':'application/json'}});}});
  ctx.importScripts=file=>vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'..','background.js'),'utf8'),ctx);
  const sender={id:'factory-test',tab:{id:42},url:'https://soundcloud.com/upload',frameId:0,documentId:'doc-1'};
  const send=(message,source=sender)=>new Promise(resolve=>handlers.message(message,source,resolve));
  return {state,calls,removed,reloaded,handlers,send,sender};
}
test('a worker dispatches an upload once; new document only inspects',async()=>{
  const f=fixture();const one=await f.send({type:'content.ready',contentRevision:'upload-control-v5'});assert.equal(one.job.id,'j1');
  const two=await f.send({type:'content.ready',contentRevision:'upload-control-v5'});assert.equal(two.job,undefined);assert.equal(two.inspect.id,'j1');
});
test('stale content script is rejected before a job can be dispatched',async()=>{
  const f=fixture();const r=await f.send({type:'content.ready'});
  assert.equal(r.ok,false);assert.match(r.error,/старый скрипт Bridge/);assert.equal(f.state.active.phase,'ready');
});
test('old discover document is ignored while its tab navigates, then uploader receives the job',async()=>{
  const f=fixture();f.state.active.phase='navigating';
  const old=await f.send({type:'content.ready',contentRevision:'upload-control-v5'},{...f.sender,url:'https://soundcloud.com/discover'});
  assert.equal(old.ok,true);assert.equal(old.job,undefined);assert.equal(f.state.active.phase,'navigating');
  const uploader=await f.send({type:'content.ready',contentRevision:'upload-control-v5'},{...f.sender,url:'https://soundcloud.com/upload',documentId:'doc-2'});
  assert.equal(uploader.ok,true);assert.equal(uploader.job.id,'j1');assert.equal(f.state.active.phase,'dispatched');
});
test('unknown tabs and website messages cannot fetch local audio',async()=>{
  const f=fixture();const r=await f.send({type:'content.audio',trackId:'t1',offset:0},{...f.sender,tab:{id:99}});
  assert.equal(r.ok,false);assert.equal(f.state.active.sideEffect,false);
});
test('home shell adopts the single upload tab created by SoundCloud and closes the stale worker tab',async()=>{
  const f=fixture();
  const source={...f.sender,tab:{id:42,windowId:7}};
  const expected=await f.send({type:'content.expectUploadTab'},source);assert.equal(expected.ok,true);
  const r=await f.send({type:'content.ready',contentRevision:'upload-control-v5'},{...f.sender,tab:{id:84,windowId:7},documentId:'doc-2'});
  assert.equal(r.ok,true);assert.equal(r.job.id,'j1');
  assert.equal(f.state.active.tabId,84);assert.equal(f.state.active.phase,'dispatched');assert.equal(f.state.active.uploadTabCreated,true);
  assert.equal(f.calls.length,0);
  assert.deepEqual(f.removed,[42]);
  const stale=await f.send({type:'content.expectUploadTab'},{...f.sender,tab:{id:84,windowId:7},documentId:'doc-2'});
  assert.equal(stale.ok,false);assert.match(stale.error,/Новые вкладки больше не открываются/);
});
test('background creates only one requested uploader tab in the worker window',async()=>{
  const f=fixture(),source={...f.sender,tab:{id:42,windowId:7}};
  const opened=await f.send({type:'content.openUploadTab',url:'https://soundcloud.com/upload'},source);assert.equal(opened.ok,true);
  assert.equal(JSON.stringify(f.calls),JSON.stringify([{url:'https://soundcloud.com/upload',active:true,windowId:7}]));
  const duplicate=await f.send({type:'content.openUploadTab',url:'https://soundcloud.com/upload'},source);assert.equal(duplicate.ok,false);
  assert.match(duplicate.error,/уже открывается/);assert.equal(f.calls.length,1);
});
test('identity mismatch blocks without navigating to uploader',async()=>{
  const f=fixture();f.state.active.phase='verifying';
  await f.send({type:'content.verified',handle:'someone-else'});
  assert.equal(f.state.active,null);assert.equal(f.calls.length,0);assert.deepEqual(f.state.attempted,['j1']);
});
test('upload checkpoint persisted before report and concurrent heartbeat cannot erase it',async()=>{
  let durable;
  const f=fixture(async(url,opts,state)=>{if(url.includes('/bridge/report'))durable=structuredClone(state);});
  await Promise.all([f.send({type:'content.report',payload:{status:'progress',message:'start',tracks:[{id:'t1',status:'uploading'}]}}),f.send({type:'content.ping'})]);
  assert.equal(durable.active.sideEffect,true);assert.match(durable.pendingReport.payload.reportId,/^[0-9a-f-]{36}$/);
  assert.equal(f.state.active.sideEffect,true);
});
test('failed report delivery retains identical durable reportId for retry',async()=>{
  const seen=[];let fail=true;
  const f=fixture(async(url,options)=>{if(url.includes('/bridge/report')){seen.push(JSON.parse(options.body).reportId);if(fail)throw new Error('offline');}});
  const r=await f.send({type:'content.report',payload:{status:'progress',message:'starting',tracks:[{id:'t1',status:'uploading'}]}});
  assert.equal(r.ok,false);assert.equal(f.state.pendingReport.payload.reportId,seen[0]);
  fail=false;await f.send({type:'popup.check'},{url:'chrome-extension://factory-test/popup.html'});
  assert.equal(seen[1],seen[0]);assert.equal(f.state.pendingReport,null);
});
test('empty completion and unverified track URLs are rejected',async()=>{
  const f=fixture();
  for(const tracks of [[],[{id:'t1',status:'published',publishUrl:'https://soundcloud.com/wrong/song'}],[{id:'t1',status:'uploading'}]]){
    const r=await f.send({type:'content.report',payload:{status:'complete',message:'done',tracks}});assert.equal(r.ok,false);
  }
  assert.notEqual(f.state.active,null);
});
test('complete evidenced results consume a job without enabling replay',async()=>{
  const f=fixture();
  const r=await f.send({type:'content.report',payload:{status:'complete',message:'done',tracks:[{id:'t1',status:'published',publishUrl:'https://soundcloud.com/bos-423483424/song'}]}});
  assert.equal(r.ok,true);assert.equal(f.state.active,null);assert.deepEqual(f.state.attempted,['j1']);
});
test('popup opens native Factory through account-authenticated focus without a UI token',async()=>{
  let request;
  const f=fixture(async(url,options)=>{if(url.includes('/bridge/focus'))request={url,options};});
  const r=await f.send({type:'popup.focus'},{url:'chrome-extension://factory-test/popup.html'});
  assert.equal(r.ok,true);
  assert.equal(request.url,'http://127.0.0.1:8788/bridge/focus');
  assert.equal(request.options.method,'POST');
  assert.equal(request.options.headers.Authorization,'Bearer abc123def456ghij');
  assert.equal(request.options.headers['X-Music-Factory-Bridge-Version'],'2.2.3');
  assert.equal(request.options.headers['X-Music-Factory-Bridge-Revision'],'playwright-primary-v1');
  assert.deepEqual(JSON.parse(request.options.body),{accountId:'bos'});
  assert.equal(f.calls.length,0);
});
test('native focus has actionable offline error and rejects website sender',async()=>{
  const f=fixture(async(url)=>{if(url.includes('/bridge/focus'))throw new Error('Connection refused');});
  const offline=await f.send({type:'popup.focus'},{url:'chrome-extension://factory-test/popup.html'});
  assert.equal(offline.ok,false);assert.match(offline.error,/Запусти Music Factory.app \/ Music Factory.exe/);
  const page=await f.send({type:'popup.focus'});assert.equal(page.ok,false);
  f.state.config=null;
  const unpaired=await f.send({type:'popup.focus'},{url:'chrome-extension://factory-test/popup.html'});
  assert.equal(unpaired.ok,false);assert.match(unpaired.error,/подключи этот профиль/);
});
