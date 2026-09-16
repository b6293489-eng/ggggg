'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
const root=path.resolve(__dirname,'..');
async function harness(t,{portConflict=false}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'factory-desktop-test-'));
  t.after(()=>fs.rmSync(dir,{recursive:true}));
  const calls={errors:[],spawn:[],requests:[]},handlers={},intervals=[];
  const app=new EventEmitter();Object.assign(app,{setName(){},setAppUserModelId(){},setPath(){},getPath:()=>dir,getVersion:()=> '2.2.3',requestSingleInstanceLock:()=>true,whenReady:()=>Promise.resolve(),quit(){calls.quit=true;app.emit('before-quit');}});
  class Window extends EventEmitter{
    constructor(options){super();calls.window=this;calls.options=options;this.webContents=new EventEmitter();this.webContents.send=(name,state)=>{calls.broadcast=state;};this.webContents.setWindowOpenHandler=fn=>{calls.openHandler=fn;};}
    isDestroyed(){return false;} isMinimized(){return true;} restore(){calls.restored=true;}show(){calls.shown=true;}focus(){calls.focused=true;}
    async loadFile(file){calls.loaded=file;}
  }
  const state={accounts:[{id:'bos',label:'Бос',chromeProfile:'Profile 7',connected:false}],tracks:[],jobs:[],paused:false};
  const factory={getState:()=>structuredClone(state),close(){calls.closed=true;},noteDispatch(id,error){calls.dispatch={id,error};},async action(action,payload){calls.requests.push({action,payload});if(action==='pause')state.paused=true;if(action==='resume')state.paused=false;return structuredClone(state);}};
  class Automation{
    constructor(){this.profiles={};this.verified={};calls.automation=this;}
    status(){return {mode:'playwright',running:false,profiles:{...this.profiles},verified:{...this.verified}};}
    async openLogin(id){this.profiles[id]=true;return {ok:true,accountId:id};}
    async verifyLogin(id){this.profiles[id]=true;this.verified[id]=true;return {ok:true,accountId:id,verified:true};}
    async close(){return {ok:true};}
    async closeAll(){calls.automationClosed=true;}
    async runQueued(id){(calls.automationRuns||(calls.automationRuns=[])).push(id);return true;}
  }
  const bridge={port:8788,token:'ui-secret',server:{close(){calls.serverClosed=true;}},pairing:{tokens:{},pair(id){this.tokens[id]='account-token';return {accountId:id,token:'account-token',port:8788};}}};
  const processMock=new EventEmitter();Object.assign(processMock,{argv:[],env:{FACTORY_DATA_DIR:dir},platform:'darwin',arch:'arm64',resourcesPath:dir});
  const electron={app,BrowserWindow:Window,ipcMain:{handle:(name,fn)=>{handlers[name]=fn;}},dialog:{showErrorBox:(...args)=>calls.errors.push(args)},shell:{},clipboard:{},Menu:{setApplicationMenu(){},buildFromTemplate:t=>t}};
  const req=name=>{
    if(name==='electron')return electron;
    if(name==='./core/index.cjs')return {Factory:class{constructor(){return factory;}}};
    if(name==='./core/playwright-runner.cjs')return {SoundCloudPlaywright:Automation};
    if(name==='./server.cjs')return {startServer:async opts=>{calls.serverOptions=opts;if(portConflict)throw Object.assign(new Error('used'),{code:'EADDRINUSE'});return bridge;}};
    if(name==='node:child_process')return {spawn:(...args)=>{calls.spawn.push(args);const child=new EventEmitter();child.unref=()=>{};return child;}};
    if(name==='node:fs')return {...fs,existsSync:file=>file==='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'||fs.existsSync(file)};
    return require(name);
  };
  vm.runInNewContext(fs.readFileSync(path.join(root,'main.cjs'),'utf8'),{require:req,__dirname:root,process:processMock,setInterval:fn=>{intervals.push(fn);return 1;},clearInterval(){},setTimeout(){},console,URL,Buffer},{filename:'main.cjs'});
  await new Promise(resolve=>setImmediate(resolve));
  const request=(action,payload)=>handlers['factory:request']({sender:calls.window.webContents},action,payload);
  return {calls,app,state,bridge,request,handlers,intervals};
}
test('desktop enables publishing only after the Playwright uploader is verified',async t=>{
  const h=await harness(t);assert.equal(h.calls.shown,true);assert.equal(h.calls.options.webPreferences.nodeIntegration,false);assert.equal(h.calls.options.webPreferences.sandbox,true);
  assert.equal((await h.request('state')).accounts[0].browserReady,false);
  await h.request('openAutomationProfile',{accountId:'bos'});
  let state=await h.request('state');assert.equal(state.accounts[0].profileCreated,true);assert.equal(state.accounts[0].browserReady,false);
  await h.request('verifyAutomationProfile',{accountId:'bos'});
  state=await h.request('state');assert.equal(state.accounts[0].browserReady,true);assert.equal(state.appVersion,'2.2.3');assert.equal(state.automationMode,'playwright');
  assert.throws(()=>h.handlers['factory:request']({sender:{}},'state'),/Unknown sender/);
  h.calls.serverOptions.onFocus();assert.equal(h.calls.focused,true);assert.equal(h.calls.restored,true);
});
test('startup port conflict exits cleanly instead of retaining an invisible instance',async t=>{
  const h=await harness(t,{portConflict:true});assert.equal(h.calls.quit,true);assert.equal(h.calls.window,undefined);assert.match(h.calls.errors[0][1],/8788/);assert.equal(h.calls.closed,true);
});
test('queued SoundCloud work is dispatched once to Playwright',async t=>{
  const h=await harness(t);h.state.jobs.push({id:'j1',type:'publish',status:'queued',accountId:'bos'});
  h.intervals[0]();h.intervals[0]();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(h.calls.automationRuns,['bos']);assert.equal(h.calls.spawn.length,0);
  assert.equal(h.calls.dispatch.id,'j1');
  await h.request('pause');h.state.jobs.unshift({id:'j2',type:'publish',status:'queued',accountId:'bos'});h.intervals[0]();assert.equal(h.calls.automationRuns.length,1);
});
test('privileged window rejects arbitrary local and remote navigation',async t=>{
  const h=await harness(t);let prevented=0;
  for(const url of ['file:///tmp/untrusted.html','https://soundcloud.com/'])h.calls.window.webContents.emit('will-navigate',{preventDefault:()=>prevented++},url);
  assert.equal(prevented,2);
});
