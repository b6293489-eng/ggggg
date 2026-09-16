'use strict';
const path=require('node:path');
const fs=require('node:fs');
const {Factory}=require('./core/index.cjs');
const {startServer}=require('./server.cjs');
const dataDir=path.resolve(process.env.FACTORY_DATA_DIR||'../../work/factory-preview');fs.mkdirSync(dataDir,{recursive:true});
const factory=new Factory(dataDir,{seedManifest:path.resolve('../public_upload_batches/us_2026_09_08/publish_manifest.json'),resourcesDir:__dirname});
let service;
async function action(name,payload){
  if(name==='state')return factory.getState();
  if(name==='audioUrl')return `http://127.0.0.1:${service.port}/audio/${payload.trackId}?token=${service.token}`;
  if(name==='diagnostics')return {platform:process.platform,mode:'browser-preview',bridgePort:service.port};
  if(['copy','bridgePair','openChrome','chooseAcePath','pickAudio','pickQueue','openExtensionFolder','openLogs','exportBackup','importBackup','exportQueue','revealTrack'].includes(name))throw new Error('Это действие доступно в приложении Music Factory.');
  return factory.action(name,payload);
}
startServer({factory,dataDir,uiDir:path.join(__dirname,'ui'),action,port:Number(process.env.FACTORY_PORT||8788)}).then(s=>{service=s;console.log(`Music Factory preview: http://127.0.0.1:${s.port}/#${s.token}`);});
process.on('SIGINT',()=>{factory.close();service?.server.close();process.exit();});
process.on('SIGTERM',()=>{factory.close();service?.server.close();process.exit();});
