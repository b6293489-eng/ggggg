'use strict';
// Validates the deliverable using the shipped Factory importer, in isolated data.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const {Factory}=require(path.join(root,'outputs/music-factory-desktop/core/index.cjs'));
const file=process.argv[2]||path.join(root,'outputs/USA_60_tracks_2026-09-10.json');
const queue=JSON.parse(fs.readFileSync(file,'utf8'));
const accounts=['bos-423483424','gleb-oxaj','rivi-135338423'];
const originals=JSON.parse(fs.readFileSync(path.join(root,'outputs/public_upload_batches/us_2026_09_08/publish_manifest.json'),'utf8')).accounts.flatMap(a=>a.tracks.map(t=>t.title.toLowerCase()));
assert.equal(queue.length,60);
assert.equal(new Set(queue.map(t=>t.release_title.toLowerCase())).size,60);
assert.equal(new Set(queue.map(t=>t.output_name)).size,60);
const vocalWords=[],durations=[],byAccount={};
for(const a of accounts){
  const tracks=queue.filter(t=>t.target_account===a);
  assert.equal(tracks.length,20,a);
  assert.equal(tracks.filter(t=>t.vocal_language==='en').length,16,a);
  assert.equal(tracks.filter(t=>t.vocal_language==='unknown').length,4,a);
  byAccount[a]={tracks:20,vocal:16,instrumental:4,seconds:tracks.reduce((n,t)=>n+t.duration,0)};
}
for(const [index,t] of queue.entries()){
  const label=`${index+1}: ${t.release_title}`;
  assert.equal(typeof t.release_title,'string',label);assert(t.release_title.length>2&&t.release_title.length<=100,label);
  assert(!originals.includes(t.release_title.toLowerCase()),'Existing title: '+label);
  assert(/^[a-z0-9_]+$/.test(t.output_name),label);
  assert(accounts.includes(t.target_account),label);
  assert(t.caption.length>=80&&t.caption.length<4000,label);
  assert(t.duration>=150&&t.duration<=195,label);durations.push(t.duration);
  assert(t.bpm>=30&&t.bpm<=240,label);assert(/^[A-G](?:#|b)? (?:major|minor)$/.test(t.key_scale),label);
  assert.equal(t.time_signature,'4',label);assert.equal(t.explicit,false,label);
  if(t.vocal_language==='en'){
    const words=t.lyrics.replace(/\[[^\]]+\]/g,'').trim().split(/\s+/).length;vocalWords.push(words);
    assert(words>=140&&words<=200,`${label} lyric words ${words}`);
    assert((t.lyrics.match(/\[Chorus\]/g)||[]).length>=2,label);
    const sections=[...t.lyrics.matchAll(/\[Chorus\]\s*([\s\S]*?)(?=\n\[|$)/g)].map(m=>m[1].trim());
    assert.equal(sections[0],sections[sections.length-1],`${label} chorus must be written out exactly`);
    assert(!/\b(repeat chorus|insert lyrics|lyrics here|lorem ipsum)\b/i.test(t.lyrics),label);
  }else{
    assert.equal(t.lyrics,'[Instrumental]',label);assert(/instrumental/i.test(t.caption),label);
  }
}
const data=fs.mkdtempSync(path.join(__dirname,'usa60-import-check-'));
const factory=new Factory(data,{seedManifest:false,startHealth:false,tickMs:100000000});
(async()=>{
  try{
    const imported=await factory.action('importQueue',{queue});assert.equal(imported.imported.length,60);assert.equal(imported.skipped.length,0);
    const state=factory.getState();assert.equal(state.jobs.length,0);assert(state.tracks.every(t=>t.status==='planned'&&!t.path));
    assert.equal(state.tracks.filter(t=>t.accountId==='bos').length,20);assert.equal(state.tracks.filter(t=>t.accountId==='gleb').length,20);assert.equal(state.tracks.filter(t=>t.accountId==='rivi').length,20);
    const retry=await factory.action('importQueue',{queue});assert.equal(retry.imported.length,0);assert.equal(retry.skipped.length,60);
    console.log(JSON.stringify({result:'PASS',file,tracks:60,vocal:48,instrumental:12,byAccount,durationRange:[Math.min(...durations),Math.max(...durations)],audioSeconds:durations.reduce((a,b)=>a+b,0),lyricWordRange:[Math.min(...vocalWords),Math.max(...vocalWords)],imported:60,repeatImportSkipped:60,jobsStarted:0,testData:data},null,2));
  }finally{factory.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
