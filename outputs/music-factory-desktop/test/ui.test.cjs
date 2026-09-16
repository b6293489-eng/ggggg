'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('../extension/test/node_modules/jsdom');

const root=path.resolve(__dirname,'..');
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('full-cycle dialog sends one public album title per account with Amplify enabled',async t=>{
  const html=fs.readFileSync(path.join(root,'ui','index.html'),'utf8').replace('<script src="app.js"></script>','');
  const dom=new JSDOM(html,{url:'https://factory.local/',runScripts:'outside-only',pretendToBeVisual:true});
  t.after(()=>dom.window.close());
  const {window}=dom,calls=[];
  const dialog=window.document.getElementById('dialog');
  dialog.showModal=function(){this.setAttribute('open','');};
  dialog.close=function(){this.removeAttribute('open');};
  const accounts=[
    {id:'bos',label:'Бос',handle:'bos-423483424',paired:true,connected:false},
    {id:'gleb',label:'Gleb fps',handle:'nn1v-680019554',paired:true,connected:false},
    {id:'rivi',label:'Rivi',handle:'rivi-135338423',paired:true,connected:false}
  ];
  const tracks=accounts.map((account,index)=>({id:'track-'+account.id,title:'Song '+(index+1),accountId:account.id,status:'ready',duration:180,path:'/tmp/'+account.id+'.wav',input:{caption:'USA test'}}));
  const state={appVersion:'2.1.0',accounts,tracks,jobs:[],events:[],paused:false,pipeline:null,ace:{},settings:{hardware:'mac',acePath:'',aceUrl:'http://127.0.0.1:7860'}};
  window.factory={request:async(action,payload={})=>{if(action!=='state')calls.push({action,payload});return structuredClone(state);},onState:()=>()=>{}};
  window.eval(fs.readFileSync(path.join(root,'ui','app.js'),'utf8'));
  await tick();

  window.document.querySelector('[data-view="library"]').click();
  const selectAll=window.document.getElementById('select-all');
  selectAll.checked=true;selectAll.dispatchEvent(new window.Event('change',{bubbles:true}));
  window.document.querySelector('[data-action="runPipeline"]').click();
  await tick();

  const albumInputs=[...window.document.querySelectorAll('[id^="album-title-"]')];
  assert.equal(albumInputs.length,3);
  albumInputs.forEach((input,index)=>{input.value=['Bos Album','Gleb Album','Rivi Album'][index];});
  assert.equal(window.document.getElementById('publish-amplify').checked,true);
  window.document.getElementById('cycle-monetize').checked=true;
  window.document.querySelector('#dialog [data-action="confirmJob"]').click();
  await tick();await tick();

  assert.equal(calls.length,1);
  assert.equal(calls[0].action,'runPipeline');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].payload.albumTitles)),{bos:'Bos Album',gleb:'Gleb Album',rivi:'Rivi Album'});
  assert.equal(calls[0].payload.amplify,true);
  assert.equal(calls[0].payload.monetize,true);
  assert.deepEqual([...calls[0].payload.trackIds],['track-bos','track-gleb','track-rivi']);
});

test('active pipeline exposes a confirmed finish action',async t=>{
  const html=fs.readFileSync(path.join(root,'ui','index.html'),'utf8').replace('<script src="app.js"></script>','');
  const dom=new JSDOM(html,{url:'https://factory.local/',runScripts:'outside-only',pretendToBeVisual:true});t.after(()=>dom.window.close());
  const {window}=dom,calls=[],dialog=window.document.getElementById('dialog');
  dialog.showModal=function(){this.setAttribute('open','');};dialog.close=function(){this.removeAttribute('open');};
  const state={appVersion:'2.1.0',accounts:[{id:'bos',label:'Бос',handle:'bos-423483424',paired:true}],tracks:[{id:'t',title:'Song',accountId:'bos',status:'ready',duration:180,path:'/tmp/t.wav',input:{}}],jobs:[],events:[],paused:true,pipeline:{id:'p',active:true,stage:'attention',message:'Нужна проверка',trackIds:['t']},ace:{},settings:{hardware:'mac',acePath:'',aceUrl:'http://127.0.0.1:7860'}};
  window.factory={request:async(action,payload={})=>{if(action!=='state')calls.push({action,payload});if(action==='finishPipeline'){state.pipeline.active=false;state.paused=false;}return structuredClone(state);},onState:()=>()=>{}};
  window.eval(fs.readFileSync(path.join(root,'ui','app.js'),'utf8'));await tick();
  window.document.querySelector('[data-action="finishPipeline"]').click();await tick();
  assert.match(window.document.getElementById('dialog-content').textContent,/Ещё не начатые задания/);
  window.document.querySelector('[data-action="confirmFinishPipeline"]').click();await tick();await tick();
  assert.equal(calls.at(-1).action,'finishPipeline');
});

test('Windows setup wizard can auto-detect ACE-Step without an old Codex chat',async t=>{
  const html=fs.readFileSync(path.join(root,'ui','index.html'),'utf8').replace('<script src="app.js"></script>','');
  const dom=new JSDOM(html,{url:'https://factory.local/',runScripts:'outside-only',pretendToBeVisual:true});t.after(()=>dom.window.close());
  const {window}=dom,calls=[],dialog=window.document.getElementById('dialog');
  dialog.showModal=function(){this.setAttribute('open','');};dialog.close=function(){this.removeAttribute('open');};
  const state={appVersion:'2.1.0',platform:'win32',accounts:[{id:'bos',label:'Бос',handle:'bos-423483424',paired:false}],tracks:[],jobs:[],events:[],paused:false,pipeline:null,ace:{online:false,status:'offline'},aceInstallation:{valid:false},settings:{hardware:'rtx4060',memoryMode:'restart',acePath:'',aceUrl:'http://127.0.0.1:7860'}};
  window.factory={request:async(action,payload={})=>{if(action!=='state')calls.push({action,payload});if(action==='detectAce'){state.settings.acePath='C:\\Users\\Test\\Documents\\ACE-Step-1.5';state.aceInstallation={valid:true};return {path:state.settings.acePath,state:structuredClone(state)};}return structuredClone(state);},onState:()=>()=>{}};
  window.eval(fs.readFileSync(path.join(root,'ui','app.js'),'utf8'));await tick();
  window.document.querySelector('[data-view="settings"]').click();
  window.document.querySelector('[data-action="windowsSetup"]').click();await tick();
  assert.match(window.document.getElementById('dialog-content').textContent,/Старый чат Codex/);
  window.document.querySelector('#dialog [data-action="detectAce"]').click();await tick();await tick();
  assert.equal(calls.at(-1).action,'detectAce');
  assert.match(window.document.getElementById('dialog-content').textContent,/ACE-Step-1.5/);
});
