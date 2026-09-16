const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');
const scripts=['core.js','content.js'].map(file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8'));
const baseJob=()=>({id:'album-job',type:'publish',accountId:'bos',handle:'bos-423483424',identityMode:'paired-profile',
  uploadMode:'album',albumTitle:'Daylight Postcards',amplify:true,tracks:[
    {id:'first',title:'First Song',filename:'01 - First Song.wav',mime:'audio/wav'},
    {id:'second',title:'Second Song',filename:'02 - Second Song.wav',mime:'audio/wav'}]});
async function runFixture(t,options={}) {
  const job={...baseJob(),...options.job};
  const dom=new JSDOM(`<!doctype html><html><body><header><nav><a id="nav-upload" href="/upload">Upload</a><button id="nav-upload-button">Upload</button></nav></header><main><label><input id="group" type="checkbox">Make a playlist when multiple files selected</label>${options.shellFirst?'':'<input id="files" type="file" multiple accept="audio/*">'}<div id="editor" hidden></div></main></body></html>`,
    {url:job.type==='monetize'?'https://artists.soundcloud.com/monetization':'https://soundcloud.com/upload',runScripts:'outside-only',pretendToBeVisual:true});
  const {window:w}=dom;const events=[],reports=[],submitted=[];let ack=false,terminalResolve;
  t.after(()=>w.close());
  // jsdom has a complete DOM but no layout engine. Supply visible geometry only.
  w.Element.prototype.getClientRects=function(){return this.closest('[hidden]')||this.style.display==='none'?[]:[{width:100,height:30}];};
  w.Element.prototype.getBoundingClientRect=function(){return {width:100,height:this.getClientRects().length?30:0};};
  Object.defineProperty(w.HTMLElement.prototype,'innerText',{get(){return this.textContent;},configurable:true});
  if(options.navMarkedHidden){
    w.document.querySelector('#nav-upload').setAttribute('aria-hidden','true');
    w.document.querySelector('#nav-upload').style.display='none';
  }
  let now=Date.now();w.Date.now=()=>now;
  w.setTimeout=(fn,delay)=>setTimeout(()=>{now+=Number(delay)||0;fn();},0);
  w.setInterval=()=>1;w.clearInterval=()=>{};
  // DataTransfer's browser-owned FileList is represented locally; content.js still creates File objects.
  w.DataTransfer=class {constructor(){this.list=[];this.items={add:file=>this.list.push(file)};}get files(){return this.list;}};
  const fileLists=new WeakMap();
  Object.defineProperty(w.HTMLInputElement.prototype,'files',{get(){return fileLists.get(this)||[];},set(v){fileLists.set(this,v);},configurable:true});
  const terminal=new Promise(resolve=>{terminalResolve=resolve;});
  w.chrome={runtime:{sendMessage:async message=>{
    if(message.type==='content.ready'){
      assert.equal(message.contentRevision,'upload-control-v5');
      return {ok:true,job};
    }
    if(message.type==='content.ping')return {ok:true,continue:true};
    if(message.type==='content.audio'){events.push('audio:'+message.trackId);return {ok:true,data:Buffer.from('WAVE').toString('base64'),offset:0,total:4,length:4};}
    if(message.type==='content.verified'){events.push('verified');return {ok:true};}
    if(message.type==='content.expectUploadTab'){
      events.push('expect-upload-tab');
      setTimeout(()=>terminalResolve({status:'navigation'}),0);
      return {ok:true};
    }
    if(message.type==='content.openUploadTab'){
      events.push('open-upload-tab:'+message.url);
      setTimeout(()=>terminalResolve({status:'navigation'}),0);
      return {ok:true};
    }
    if(message.type==='content.report'){
      const p=JSON.parse(JSON.stringify(message.payload));reports.push(p);
      if(p.tracks.some(track=>track.status==='uploading')){
        events.push('checkpoint');
        if(options.rejectCheckpoint&&p.status==='progress'&&!ack)throw new Error('Server unavailable before file transfer');
        await Promise.resolve();ack=true;
      }
      if(p.status!=='progress')setTimeout(()=>terminalResolve(p),0);
      return {ok:true};
    }
    throw new Error('Unexpected message '+message.type);
  }}};
  w.document.querySelector('#nav-upload').addEventListener('click',e=>{e.preventDefault();if(options.shellFirst){events.push('nav-upload');installFileInput();}else events.push('BAD-nav');});
  w.document.querySelector('#nav-upload-button').addEventListener('click',()=>events.push('BAD-nav-button'));
  function installFileInput(){
    let fileInput=w.document.querySelector('#files');
    if(!fileInput){w.document.querySelector('main').insertAdjacentHTML('afterbegin','<input id="files" type="file" multiple accept="audio/*">');fileInput=w.document.querySelector('#files');}
    if(fileInput.dataset.testReady)return;fileInput.dataset.testReady='1';
    fileInput.addEventListener('change',event=>{
    assert.equal(ack,true,'backend acknowledged durable uploading checkpoint before change');
    events.push('file-change');
    assert.equal(w.document.querySelector('#group').checked,true,'album/playlist grouping retained');
    assert.deepEqual([...event.target.files].map(f=>f.name),['First Song.wav','Second Song.wav']);
    const editor=w.document.querySelector('#editor');editor.hidden=false;
    editor.innerHTML=`<form id="album-form"><h1>Album info</h1><label for="album-name">Album title*</label><input id="album-name" name="title" required><fieldset><legend>Album Privacy</legend><label><input id="privacy-public" type="radio" name="privacy" value="public">Public</label><label><input id="privacy-private" type="radio" name="privacy" value="private" checked>Private</label></fieldset><label for="album-type">Album type</label><select id="album-type"><option>Album</option></select><label for="main-artist">Main Artist(s)</label><input id="main-artist" value="Hlib Okhai"><h2>Tracks</h2><ol><li><input name="title" aria-label="Title" value="First Song.wav"></li><li><input name="title" aria-label="Title" value="Second Song.wav"></li></ol><button id="amplify" type="button">Amplify tracks</button><footer><button id="final-upload" type="button">Upload</button></footer></form>`;
    const album=w.document.querySelector('#album-name');
    album.addEventListener('input',()=>events.push('album-title:'+album.value));
    w.document.querySelector('#privacy-public').addEventListener('click',()=>events.push('public'));
    const amp=w.document.querySelector('#amplify');
    amp.addEventListener('click',()=>{
      events.push('amplify');assert.equal(album.value,job.albumTitle);assert.equal(w.document.querySelector('#privacy-public').checked,true);
      if(options.amplifyState==='unknown'){amp.textContent='Working…';return;}
      if(options.amplifyState==='payment'||options.amplifyState==='modal'){
        const dialog=w.document.createElement('div');dialog.setAttribute('role','dialog');
        dialog.innerHTML=options.amplifyState==='payment'?'<h2>Upgrade Artist Pro</h2><button>Pay now</button>':'<h2>Choose your options</h2><button>Continue</button>';
        dialog.querySelector('button').addEventListener('click',()=>events.push('BAD-modal-action'));
        w.document.body.append(dialog);return;
      }
      if(options.amplifyState==='pressed'){amp.setAttribute('aria-pressed','true');return;}
      amp.remove();
      const banner=w.document.createElement('div');banner.setAttribute('role','status');
      banner.innerHTML=`<h3>We'll analyze your tracks for recommendation</h3><p>Hang tight! Once your tracks are uploaded, we'll analyze them and see if they are eligible to be recommended to the right audience.</p><span aria-hidden="true">✓</span>`;
      w.document.querySelector('#album-form').append(banner);events.push('amplify-ack');
    });
    if(options.externalBanner){const outside=w.document.createElement('aside');outside.textContent="We'll analyze your tracks for recommendation";w.document.body.append(outside);}
    if(options.duplicateFinal){const duplicate=w.document.createElement('button');duplicate.type='button';duplicate.textContent='Upload';w.document.querySelector('footer').append(duplicate);}
    if(options.removePublic)w.document.querySelector('fieldset').remove();
    w.document.querySelector('#final-upload').addEventListener('click',()=>{
      events.push('final-upload');
      submitted.push({album:album.value,public:w.document.querySelector('#privacy-public').checked,
        titles:[...w.document.querySelectorAll('li input')].map(e=>e.value),mainArtist:w.document.querySelector('#main-artist').value});
      editor.innerHTML='<p>Successfully uploaded</p><a href="https://soundcloud.com/bos-423483424/first-song">First Song</a><a href="https://soundcloud.com/bos-423483424/second-song">Second Song</a>';
    });
    });
  }
  if(!options.shellFirst)installFileInput();
  w.eval(scripts[0]);w.eval(scripts[1]);
  const timeout=setTimeout(()=>terminalResolve({status:'TEST_TIMEOUT'}),10000);t.after(()=>clearTimeout(timeout));
  const result=await terminal;
  return {result,events,reports,submitted,window:w};
}
test('actual content.js: paired album workflow checkpoints files then title → Public → Amplify banner → footer Upload',async t=>{
  const f=await runFixture(t);
  assert.equal(f.result.status,'complete',f.result.message);
  assert(f.events.indexOf('checkpoint')<f.events.indexOf('file-change'));
  assert(f.events.indexOf('album-title:Daylight Postcards')<f.events.indexOf('amplify'));
  assert(f.events.indexOf('amplify-ack')<f.events.indexOf('final-upload'));
  assert.equal(f.events.filter(e=>e==='final-upload').length,1);
  assert(!f.events.some(e=>e.startsWith('BAD-')||e==='verified'));
  assert.deepEqual(f.submitted,[{album:'Daylight Postcards',public:true,titles:['First Song','Second Song'],mainArtist:'Hlib Okhai'}]);
  assert(f.reports.some(p=>/проверит треки для рекомендаций/.test(p.message)));
  assert(f.result.tracks.every(track=>track.status==='published'&&track.publishUrl));
});
test('actual content.js: home shell requests exactly one uploader tab even when SoundCloud marks its sole Upload anchor hidden',async t=>{
  const f=await runFixture(t,{shellFirst:true,navMarkedHidden:true});
  assert.equal(f.result.status,'navigation',f.result.message);
  assert.deepEqual(f.events.filter(e=>e.startsWith('open-upload-tab:')),['open-upload-tab:https://soundcloud.com/upload']);
  assert.equal(f.events.filter(e=>e==='nav-upload').length,0);
  assert(!f.events.includes('BAD-nav-button'));
  assert(!f.events.includes('file-change'));
});
test('actual content.js: unknown Amplify state stops before final Upload even with matching text outside album form',async t=>{
  const f=await runFixture(t,{amplifyState:'unknown',externalBanner:true});
  assert.equal(f.result.status,'blocked');assert.match(f.result.message,/не показал подтверждение/);
  assert(!f.events.includes('final-upload'));assert(f.result.tracks.every(track=>track.status==='uncertain'));
});
test('actual content.js: paid upsell after Amplify never buys or submits upload',async t=>{
  const f=await runFixture(t,{amplifyState:'payment'});
  assert.equal(f.result.status,'blocked');assert.match(f.result.message,/оплату|подписки/);
  assert(!f.events.some(e=>e==='final-upload'||e==='BAD-modal-action'));
});
test('actual content.js: unknown modal after Amplify stops with no modal action',async t=>{
  const f=await runFixture(t,{amplifyState:'modal'});
  assert.equal(f.result.status,'blocked');assert.match(f.result.message,/дополнительное окно/);
  assert(!f.events.some(e=>e==='final-upload'||e==='BAD-modal-action'));
});
test('actual content.js: button state alone cannot confirm Amplify and false flag skips it',async t=>{
  const pressed=await runFixture(t,{amplifyState:'pressed'});assert.equal(pressed.result.status,'blocked');assert(!pressed.events.includes('final-upload'));
  const disabled=await runFixture(t,{job:{amplify:false}});assert.equal(disabled.result.status,'complete');assert(!disabled.events.includes('amplify'));
});
test('actual content.js: Public unavailable or ambiguous footer never submits',async t=>{
  for(const option of [{removePublic:true},{duplicateFinal:true}]){
    const f=await runFixture(t,option);assert.equal(f.result.status,'blocked');assert(!f.events.includes('final-upload'));
  }
});
test('actual content.js: failed checkpoint prevents file-change and upload',async t=>{
  const f=await runFixture(t,{rejectCheckpoint:true});
  assert.equal(f.result.status,'blocked');assert(!f.events.includes('file-change'));assert(!f.events.includes('final-upload'));
});
test('actual content.js: DOM header identity check is removed in favor of profile binding',async t=>{
  const f=await runFixture(t,{job:{identityMode:'paired-profile'}});
  assert.equal(f.result.status,'complete');
});
test('actual content.js: paired monetization skips header identity but keeps target-track validation',async t=>{
  const f=await runFixture(t,{job:{type:'monetize',account:{rightsConfirmed:true,legalName:'Test Author',mainArtist:'Test Artist',songwriterRole:'writer',isrc:null},
    tracks:[{id:'first',title:'First Song',publishUrl:'https://soundcloud.com/bos-423483424/first-song',explicit:false,isrc:null}]}});
  assert.equal(f.result.status,'blocked');assert.match(f.result.message,/строку/);assert.doesNotMatch(f.result.message,/аккаунт/);
});
