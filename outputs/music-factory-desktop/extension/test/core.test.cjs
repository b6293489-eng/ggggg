const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../core.js');
const job=()=>({id:'job-1',accountId:'bos',type:'publish',handle:'bos-423483424',tracks:[{id:'one',title:'Porcelain Sky',filename:'01 - Porcelain Sky.wav'}]});
test('pairing permits only scoped known accounts and opaque tokens',()=>{
  assert.deepEqual(F.validateConfig({accountId:'bos',token:'abc123def456ghij'}),{accountId:'bos',token:'abc123def456ghij',port:8788});
  assert.throws(()=>F.validateConfig({accountId:'other',token:'abc123def456ghij'}));
  assert.throws(()=>F.validateConfig({accountId:'bos',token:'http://secret'}));
});
test('job cannot cross account or contain duplicate titles or IDs',()=>{
  F.validateJob(job(),{accountId:'bos'});
  assert.throws(()=>F.validateJob(job(),{accountId:'rivi'}));
  for(const track of [{id:'one',title:'Other'},{id:'two',title:' PORCELAIN   SKY '}]) {
    const j=job();j.tracks.push(track);assert.throws(()=>F.validateJob(j,{accountId:'bos'}));
  }
});
test('track evidence rejects other accounts, private secret links, non-track URLs',()=>{
  assert.equal(F.trackUrl('https://soundcloud.com/bos-423483424/porcelain-sky','bos-423483424'),'https://soundcloud.com/bos-423483424/porcelain-sky');
  for(const url of ['https://evil.test/bos-423483424/title','https://soundcloud.com/other/title',
    'https://soundcloud.com/bos-423483424/sets','https://soundcloud.com/bos-423483424/title/s-secret',
    'https://soundcloud.com/bos-423483424/title?secret_token=s-foo','http://soundcloud.com/bos-423483424/title'])assert.equal(F.trackUrl(url,'bos-423483424'),null);
});
test('profile detection does not identify /you or uploader as a user',()=>{
  assert.equal(F.profileHandle('/you'),null);assert.equal(F.profileHandle('/upload'),null);
  assert.equal(F.profileHandle('/bos-423483424'),'bos-423483424');
});
test('a result needs exact unambiguous title and correct account URL',()=>{
  const links=[{title:'Porcelain Sky',url:'https://soundcloud.com/bos-423483424/porcelain-sky'}];
  assert.equal(F.verifiedResults(job(),links).length,1);
  links.push({title:'Porcelain Sky',url:'https://soundcloud.com/bos-423483424/porcelain-sky-2'});
  assert.equal(F.verifiedResults(job(),links).length,0);
});
test('files retain clean song titles without numeric prefixes from local filename',()=>{
  assert.equal(F.outputName(job().tracks[0]),'Porcelain Sky.wav');
  assert.equal(F.outputName({title:'../hello: there?',filename:'anything.MP3'}),'..-hello- there-.mp3');
});
test('AI music does not imply human songwriting or default no-ISRC',()=>{
  const j=job();j.account={rightsConfirmed:true,legalName:'Test Person',mainArtist:'BOS'};
  assert.throws(()=>F.monetizationMetadata(j,{title:'One',explicit:false}));
  j.account.songwriterRole='representative';
  assert.throws(()=>F.monetizationMetadata(j,{title:'One',explicit:false}));
  j.account.isrc=null;
  assert.equal(F.monetizationMetadata(j,{title:'One',explicit:false}).contentRating,'Not Explicit');
  assert.throws(()=>F.monetizationMetadata(j,{title:'One',explicit:false,rightsConfirmed:false}));
});
test('explicit content and supplied ISRC are preserved',()=>{
  const j=job();j.account={rightsConfirmed:true,legalName:'Test Person',mainArtist:'BOS',songwriterRole:'writer',isrc:null};
  const m=F.monetizationMetadata(j,{title:'One',explicit:true,isrc:'USAAA2600001'});
  assert.equal(m.contentRating,'Explicit');assert.equal(m.isrc,'USAAA2600001');
  assert.throws(()=>F.monetizationMetadata(j,{title:'One',explicit:true,isrc:''}));
});
test('interruption preserves confirmed tracks but marks unfinished effects uncertain',()=>{
  assert.deepEqual(F.afterSideEffect([{id:'1',status:'published'},{id:'2',status:'uploading'}]),[{id:'1',status:'published'},{id:'2',status:'uncertain'}]);
});
