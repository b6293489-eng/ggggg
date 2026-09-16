'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const APP_VERSION = require('./package.json').version;
const BRIDGE_VERSION_HEADER = 'x-music-factory-bridge-version';
const BRIDGE_REVISION_HEADER = 'x-music-factory-bridge-revision';
const BRIDGE_REVISION = 'playwright-primary-v1';
const BRIDGE_PROTOCOL_MAJOR = 2;
const BRIDGE_MIN_VERSION = [2, 1, 0];

const MIME = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.wav':'audio/wav','.mp3':'audio/mpeg','.flac':'audio/flac','.m4a':'audio/mp4'};
function same(a,b) { const x=Buffer.from(a||''),y=Buffer.from(b||''); return x.length===y.length && crypto.timingSafeEqual(x,y); }
function bridgeCompatible(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value || ''));
  if (!match) return false;
  const version = match.slice(1).map(Number);
  if (version[0] !== BRIDGE_PROTOCOL_MAJOR) return false;
  for (let i = 0; i < version.length; i++) {
    if (version[i] > BRIDGE_MIN_VERSION[i]) return true;
    if (version[i] < BRIDGE_MIN_VERSION[i]) return false;
  }
  return true;
}
function readJson(req) {
  return new Promise((resolve,reject)=> { let size=0, chunks=[];
    req.on('data',c=>{size+=c.length; if(size>2*1024*1024){reject(new Error('Слишком большой запрос'));req.destroy();} else chunks.push(c);});
    req.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString()||'{}'));}catch{reject(new Error('Некорректный JSON'));}});
    req.on('error',reject);
  });
}
class Pairing {
  constructor(dataDir) { this.file=path.join(dataDir,'bridge-keys.json'); this.tokens={}; try{this.tokens=JSON.parse(fs.readFileSync(this.file,'utf8'));}catch{} }
  pair(accountId) { const token=crypto.randomBytes(32).toString('hex'); this.tokens[accountId]=token; fs.mkdirSync(path.dirname(this.file),{recursive:true}); fs.writeFileSync(this.file+'.tmp',JSON.stringify(this.tokens),{mode:0o600});fs.renameSync(this.file+'.tmp',this.file);return {accountId,token,port:8788}; }
  account(token) { return Object.keys(this.tokens).find(id=>same(this.tokens[id],token)); }
}
function streamFile(req,res,file) {
  const stat=fs.statSync(file); let start=0,end=stat.size-1,code=200;
  if(req.headers.range) {
    const m=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
    if(!m || +m[1]>=stat.size || (m[2] && +m[2]<+m[1])) {res.writeHead(416,{'Content-Range':`bytes */${stat.size}`});return res.end();}
    start=+m[1];end=m[2]?Math.min(+m[2],end):end;code=206;
  }
  const headers={'Content-Type':MIME[path.extname(file).toLowerCase()]||'application/octet-stream','Content-Length':end-start+1,'Accept-Ranges':'bytes','Cache-Control':'no-store'};
  if(code===206)headers['Content-Range']=`bytes ${start}-${end}/${stat.size}`;
  res.writeHead(code,headers); if(req.method==='HEAD')return res.end();
  fs.createReadStream(file,{start,end}).on('error',()=>res.destroy()).pipe(res);
}
async function startServer({factory,dataDir,uiDir,action,onFocus,bridgeJobsEnabled=true,port=8788}) {
  const token=crypto.randomBytes(32).toString('hex'), pairing=new Pairing(dataDir);
  const server=http.createServer(async(req,res)=>{
    const json=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
    try{
      const url=new URL(req.url,'http://127.0.0.1:'+port);
      if(req.headers.host!==`127.0.0.1:${server.address().port}` && req.headers.host!==`localhost:${server.address().port}`)return json(403,{error:'Invalid host'});
      const origin=req.headers.origin;
      if(origin && !/^chrome-extension:\/[\/][a-p]{32}$/.test(origin) && origin!==`http://127.0.0.1:${server.address().port}` && origin!=='null')return json(403,{error:'Invalid origin'});
      if(origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}
      res.setHeader('X-Content-Type-Options','nosniff');
      res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type, Range, X-Music-Factory-Bridge-Version, X-Music-Factory-Bridge-Revision');
      res.setHeader('Access-Control-Allow-Methods','GET, HEAD, POST, OPTIONS');
      res.setHeader('Access-Control-Expose-Headers','Content-Range, Content-Length, Accept-Ranges');
      res.setHeader('Access-Control-Allow-Private-Network','true');
      if(req.method==='OPTIONS'){res.writeHead(204);return res.end();}
      const bearer=(req.headers.authorization||'').replace(/^Bearer /,'');
      if(url.pathname.startsWith('/bridge/')) {
        const accountId=pairing.account(bearer);if(!accountId)return json(401,{error:'Bridge is not paired'});
        const bridgeVersion=req.headers[BRIDGE_VERSION_HEADER];
        if(!bridgeCompatible(bridgeVersion)){
          factory.bridgeRejected?.(accountId,bridgeVersion);
          return json(426,{error:`Music Factory Bridge ${bridgeVersion||'без версии'} несовместим. Нужна версия 2.1.0 или новее в линейке 2.x.`});
        }
        if(req.headers[BRIDGE_REVISION_HEADER]!==BRIDGE_REVISION){
          factory.bridgeRejected?.(accountId,`${bridgeVersion||'без версии'} · требуется Reload`);
          return json(426,{error:'Bridge нужно обновить: открой chrome://extensions в этом профиле и нажми «Обновить» у Music Factory Bridge.'});
        }
        const payload=req.method==='POST'?await readJson(req):{};
        if((payload.accountId && payload.accountId!==accountId)||(url.searchParams.has('accountId')&&url.searchParams.get('accountId')!==accountId))return json(403,{error:'Wrong account'});
        if(url.pathname==='/bridge/focus'&&req.method==='POST')return json(200,onFocus?await onFocus():{ok:false,error:'Открой приложение Music Factory вручную.'});
        if(url.pathname==='/bridge/resume'&&req.method==='POST')return json(200,action?await action('resume',{}):await factory.action('resume',{}));
        if(url.pathname==='/bridge/retry'&&req.method==='POST')return json(200,action?await action('retry',payload):await factory.action('retry',payload));
        if(url.pathname==='/bridge/publish'&&req.method==='POST')return json(200,action?await action('publish',payload):await factory.action('publish',payload));
        if(url.pathname==='/bridge/heartbeat'&&req.method==='POST'){
          try{fs.appendFileSync(path.join(dataDir,'bridge-reports.log'),`${new Date().toISOString()} [heartbeat] ${JSON.stringify(payload)}\n`);}catch(_){}
          return json(200,await factory.bridgeHeartbeat(accountId,payload));
        }
        if(url.pathname==='/bridge/job'&&req.method==='GET')return json(200,{job:bridgeJobsEnabled?await factory.claimJob(accountId):null,automation:bridgeJobsEnabled?'extension':'playwright'});
        if(url.pathname==='/bridge/report'&&req.method==='POST'){
          try{fs.appendFileSync(path.join(dataDir,'bridge-reports.log'),`${new Date().toISOString()} [${accountId}] ${JSON.stringify(payload)}\n`);}catch(_){}
          return json(200,await factory.reportJob(accountId,payload.jobId,payload));
        }
        if(url.pathname.startsWith('/bridge/audio/')&&['GET','HEAD'].includes(req.method)) {
          const id=decodeURIComponent(url.pathname.slice('/bridge/audio/'.length)),state=factory.getState();
          const track=state.tracks.find(t=>t.id===id && t.accountId===accountId);
          const active=state.jobs.some(j=>j.accountId===accountId && ['running','active','uploading','publishing'].includes(j.status) && j.trackIds.includes(id));
          if(!track||!active)return json(403,{error:'Audio is outside the active account job'});
          return streamFile(req,res,factory.audioPath(id));
        }
        return json(404,{error:'Unknown bridge endpoint'});
      }
      if(url.pathname==='/health'){return json(200,{app:'music-factory',version:APP_VERSION,bridgeProtocol:BRIDGE_PROTOCOL_MAJOR,bridgeMinimum:BRIDGE_MIN_VERSION.join('.'),bridgeRevision:BRIDGE_REVISION});}
      if(url.pathname.startsWith('/api/')||url.pathname.startsWith('/audio/')) {
        const media=url.pathname.startsWith('/audio/');
        if(!same(token,bearer) && !(media && same(token,url.searchParams.get('token'))))return json(401,{error:'Требуется запуск через Music Factory'});
        if(url.pathname==='/api/state'&&req.method==='GET')return json(200,factory.getState());
        if(url.pathname==='/api/action'&&req.method==='POST'){const body=await readJson(req);return json(200,await action(body.action,body.payload||{}));}
        if(media && ['GET','HEAD'].includes(req.method))return streamFile(req,res,factory.audioPath(decodeURIComponent(url.pathname.slice(7))));
        return json(404,{error:'Unknown endpoint'});
      }
      if(req.method!=='GET')return json(405,{error:'Method not allowed'});
      const relative=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname.slice(1));
      const file=path.resolve(uiDir,relative);if(!file.startsWith(path.resolve(uiDir)+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile())return json(404,{error:'Not found'});
      res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob: http://127.0.0.1:*; connect-src 'self' http://127.0.0.1:*; frame-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
      return streamFile(req,res,file);
    }catch(e){if(!res.headersSent)json(400,{error:e.message});else res.destroy();}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  return {server,token,pairing,port:server.address().port,close:()=>new Promise(r=>server.close(r))};
}
module.exports={startServer,Pairing,streamFile,bridgeCompatible};
