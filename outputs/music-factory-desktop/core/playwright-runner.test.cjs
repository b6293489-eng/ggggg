'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {SoundCloudPlaywright,AutomationError}=require('./playwright-runner.cjs');

function contextFixture(){
  const listeners={};const page={isClosed:()=>false,url:()=>'',bringToFront:async()=>{},goto:async url=>{page.lastUrl=url;}};
  return {page,context:{pages:()=>[page],newPage:async()=>page,setDefaultTimeout(){},setDefaultNavigationTimeout(){},on:(name,fn)=>{listeners[name]=fn;},close:async()=>{listeners.close?.();}}};
}
test('Playwright uses one isolated persistent Chrome directory per SoundCloud account',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'factory-pw-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const launches=[],fixtures=[];const browserType={launchPersistentContext:async(profile,options)=>{const f=contextFixture();fixtures.push(f);launches.push({profile,options});return f.context;}};
  const factory={getState:()=>({accounts:[{id:'bos',label:'Бос',handle:'bos-423483424'},{id:'gleb',label:'Gleb fps',handle:'nn1v-680019554'}]}),event(){}};
  const runner=new SoundCloudPlaywright({dataDir:dir,factory,browserType});
  await runner.page('bos','https://soundcloud.com/you',{headless:false});await runner.page('gleb','https://soundcloud.com/you',{headless:false});
  assert.notEqual(launches[0].profile,launches[1].profile);assert.match(launches[0].profile,/Playwright Profiles[/\\]bos$/);assert.match(launches[1].profile,/Playwright Profiles[/\\]gleb$/);
  assert.equal(launches[0].options.channel,'chrome');assert.equal(launches[0].options.headless,false);assert.equal(fixtures[0].page.lastUrl,'https://soundcloud.com/you');
  await runner.closeAll();
});
test('a Playwright failure before file transfer is reported safe without touching tracks',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'factory-pw-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const reports=[],job={id:'job-1',type:'publish',accountId:'bos',albumTitle:'Album',tracks:[{id:'track-1',title:'Song'}]};
  const factory={getState:()=>({accounts:[{id:'bos',label:'Бос',handle:'bos-423483424'}]}),claimJob:()=>job,reportJob:(_account,_job,payload)=>{reports.push(payload);return {ok:true};}};
  const runner=new SoundCloudPlaywright({dataDir:dir,factory,browserType:{}});runner.page=async()=>({});runner.close=async()=>({ok:true});
  runner.publish=async()=>{throw new AutomationError('Нужен вход');};
  await runner.runQueued('bos');
  assert.equal(reports.length,1);assert.equal(reports[0].status,'blocked');assert.equal(reports[0].safeToRetry,true);assert.deepEqual(reports[0].tracks,[]);
});
test('a SoundCloud profile becomes ready only after the uploader was verified',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'factory-pw-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const factory={getState:()=>({accounts:[{id:'bos',label:'Бос',handle:'bos-423483424'}]})};
  const runner=new SoundCloudPlaywright({dataDir:dir,factory,browserType:{}});
  fs.mkdirSync(runner.profileDir('bos'),{recursive:true});fs.writeFileSync(path.join(runner.profileDir('bos'),'Preferences'),'{}');
  assert.equal(runner.status().profiles.bos,true);assert.equal(runner.status().verified.bos,false);
  runner.markVerified('bos','https://soundcloud.com/n/upload');
  assert.equal(runner.status().verified.bos,true);
});
test('Google login opens in plain Chrome without Playwright or remote debugging flags',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'factory-pw-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const calls=[],listeners={};const child={exitCode:null,on:(name,fn)=>{listeners[name]=fn;},unref(){}};
  const factory={getState:()=>({accounts:[{id:'bos',label:'Бос',handle:'bos-423483424'}]}),event(){} };
  const runner=new SoundCloudPlaywright({dataDir:dir,factory,chromeExecutable:'/Applications/Google Chrome',spawnProcess:(file,args,options)=>{calls.push({file,args,options});return child;}});
  const result=await runner.openLogin('bos');
  assert.equal(result.mode,'manual');assert.equal(calls.length,1);assert.equal(calls[0].file,'/Applications/Google Chrome');
  assert.ok(calls[0].args.some(arg=>arg.startsWith('--user-data-dir=')));assert.ok(!calls[0].args.some(arg=>arg.includes('remote-debugging')||arg.includes('automation')));
  listeners.exit();assert.equal(runner.loginProcesses.has('bos'),false);
});
test('login verification uses the same persistent profile without showing a second browser',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'factory-pw-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const calls=[];const frame={url:()=> 'https://soundcloud.com/n/upload',locator:()=>({first:()=>({waitFor:async()=>{}})})};
  const page={isClosed:()=>false,url:()=>'',goto:async()=>{},frames:()=>[frame],locator:()=>({innerText:async()=>''})};
  const context={pages:()=>[page],newPage:async()=>page,setDefaultTimeout(){},setDefaultNavigationTimeout(){},on(){},close:async()=>{}};
  const factory={getState:()=>({accounts:[{id:'bos',label:'Бос',handle:'bos-423483424'}]}),event(){} };
  const runner=new SoundCloudPlaywright({dataDir:dir,factory,browserType:{launchPersistentContext:async(profile,options)=>{calls.push({profile,options});return context;}}});
  runner.guard=async()=>{};runner.close=async()=>({ok:true});await runner.verifyLogin('bos');
  assert.equal(calls[0].profile,runner.profileDir('bos'));assert.equal(calls[0].options.headless,true);
});
test('openLogin spawns pure clean Chrome without any debugging or automation flags',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'factory-pw-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const calls=[];const child={exitCode:null,on:()=>{},unref(){}};
  const factory={getState:()=>({accounts:[{id:'bos',label:'Бос',handle:'bos-423483424'}]}),event(){}};
  const runner=new SoundCloudPlaywright({dataDir:dir,factory,chromeExecutable:'/Applications/Google Chrome',spawnProcess:(file,args,options)=>{calls.push({file,args,options});return child;}});
  await runner.openLogin('bos');
  assert.ok(calls[0].args.includes(`--user-data-dir=${runner.profileDir('bos')}`));
  assert.ok(calls[0].args.includes('--no-first-run'));
  assert.ok(!calls[0].args.some(arg => arg.includes('remote-debugging') || arg.includes('automation') || arg.includes('mock-keychain') || arg.includes('password-store')));
});
test('verifyLogin provides rich error diagnostic details with profile path and cookie counts when not logged in',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'factory-pw-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const page={isClosed:()=>false,url:()=>'https://soundcloud.com/signin?redirect_url=/you',goto:async()=>{},frames:()=>[],locator:()=>({innerText:async()=>''})};
  const context={pages:()=>[page],newPage:async()=>page,setDefaultTimeout(){},setDefaultNavigationTimeout(){},on(){},close:async()=>{},cookies:async()=>[]};
  const factory={getState:()=>({accounts:[{id:'bos',label:'Бос',handle:'bos-423483424'}]}),event(){}};
  const runner=new SoundCloudPlaywright({dataDir:dir,factory,browserType:{launchPersistentContext:async()=>context}});
  await assert.rejects(
    ()=>runner.verifyLogin('bos'),
    (err)=>{
      assert.ok(err instanceof AutomationError);
      assert.ok(err.message.includes(runner.profileDir('bos')), 'Message must contain profile directory path');
      assert.ok(err.message.includes('Cookies:'), 'Message must explain cookies status');
      assert.ok(err.message.includes('oauth_token:'), 'Message must explain oauth_token status');
      assert.ok(err.message.includes('@bos-423483424'), 'Message must contain expected account handle');
      return true;
    }
  );
});
test('verifyLogin detects wrong account handle and throws clear mismatch error',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'factory-pw-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const page={isClosed:()=>false,url:()=>'https://soundcloud.com/other-user-999',goto:async()=>{},frames:()=>[],locator:()=>({innerText:async()=>''})};
  const context={pages:()=>[page],newPage:async()=>page,setDefaultTimeout(){},setDefaultNavigationTimeout(){},on(){},close:async()=>{},cookies:async()=>[{name:'oauth_token',value:'tok123'}]};
  const factory={getState:()=>({accounts:[{id:'bos',label:'Бос',handle:'bos-423483424'}]}),event(){}};
  const runner=new SoundCloudPlaywright({dataDir:dir,factory,browserType:{launchPersistentContext:async()=>context}});
  await assert.rejects(
    ()=>runner.verifyLogin('bos'),
    (err)=>{
      assert.ok(err instanceof AutomationError);
      assert.ok(err.message.includes('@other-user-999'), 'Message must mention observed handle');
      assert.ok(err.message.includes('@bos-423483424'), 'Message must mention expected handle');
      return true;
    }
  );
});
test('waitUploadButtonReady waits for disabled button to become enabled',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'factory-pw-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const factory={getState:()=>({accounts:[{id:'bos',label:'Бос',handle:'bos-423483424'}]}),event(){},reportJob:()=>({ok:true})};
  const runner=new SoundCloudPlaywright({dataDir:dir,factory,browserType:{}});
  let checks=0;
  const mockButton={
    isEnabled:async()=>{checks++;return checks>=3;},
    getAttribute:async attr=>attr==='aria-disabled'?(checks>=3?'false':'true'):null,
    evaluate:async fn=>fn({classList:{contains:name=>name==='Mui-disabled'&&(checks<3)}})
  };
  const mockFrame={
    evaluate:async()=>({count:2,samplePercents:['45%']}),
    locator:()=>({innerText:async()=>''})
  };
  const job={id:'job-1',accountId:'bos',albumTitle:'Album'};
  const ready=await runner.waitUploadButtonReady(mockFrame,mockButton,job,[],5000);
  assert.equal(ready,true);
  assert.ok(checks>=3);
});

