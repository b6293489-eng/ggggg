'use strict';
const {app,BrowserWindow,ipcMain,dialog,shell,clipboard,Menu}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {pathToFileURL}=require('node:url');
const {spawn}=require('node:child_process');
const {startServer}=require('./server.cjs');

app.setName('Music Factory');
app.setAppUserModelId('local.musicfactory.desktop');
const smoke=process.argv.includes('--factory-smoke-test');
if(process.env.FACTORY_DATA_DIR)app.setPath('userData',path.resolve(process.env.FACTORY_DATA_DIR));
let win,factory,bridge,automation,timer,quitting=false,automationBusy=false;
const dataDir=app.getPath('userData');
fs.mkdirSync(dataDir,{recursive:true});
const logFile=path.join(dataDir,'desktop.log');
function log(message){fs.appendFileSync(logFile,`${new Date().toISOString()} ${message}\n`);}
function handleError(error){log(error.stack||String(error));if(!quitting)dialog.showErrorBox('Music Factory — ошибка',`${error.message||error}\n\nЖурнал: ${logFile}`);}
process.on('uncaughtException',handleError);
process.on('unhandledRejection',handleError);
if(!app.requestSingleInstanceLock()){app.quit();}else{
  app.on('second-instance',()=>{if(win){if(win.isMinimized())win.restore();win.show();win.focus();}});
  app.whenReady().then(start).catch(error=>{handleError(error.code==='EADDRINUSE'?new Error('Порт 8788 занят другой копией Factory или предпросмотром. Закрой её и запусти приложение снова.'):error);app.quit();});
}
function chromeBinary(){
  const candidates=process.platform==='darwin'?['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',path.join(os.homedir(),'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')]:[path.join(process.env.PROGRAMFILES||'C:\\Program Files','Google/Chrome/Application/chrome.exe'),path.join(process.env['PROGRAMFILES(X86)']||'C:\\Program Files (x86)','Google/Chrome/Application/chrome.exe'),path.join(process.env.LOCALAPPDATA||os.homedir(),'Google/Chrome/Application/chrome.exe')];
  const binary=candidates.find(p=>fs.existsSync(p));if(!binary)throw new Error('Google Chrome не найден. Установи Chrome и войди в свои профили.');return binary;
}
function openChrome(accountId,extensions=false){
  const account=factory.getState().accounts.find(a=>a.id===accountId);if(!account)throw new Error('Неизвестный аккаунт');
  const profile=account.chromeProfile||'Default';if(!/^(Default|Profile \d+)$/.test(profile))throw new Error('Укажи профиль Chrome: Default или Profile 1, Profile 2…');
  // Chrome reuses the existing profile window when it can. Never force a new
  // window: a queued job must wake one profile only once.
  const child=spawn(chromeBinary(),[`--profile-directory=${profile}`,extensions?'chrome://extensions/':'https://soundcloud.com/'],{detached:true,stdio:'ignore',windowsHide:false});
  child.on('error',e=>log(`Chrome: ${e.message}`));child.unref();return {ok:true,message:`Открыт Chrome: ${account.label}`};
}
function syncExtensionFiles(){
  const target=path.join(dataDir,'Chrome Bridge');fs.mkdirSync(target,{recursive:true});
  fs.cpSync(path.join(__dirname,'extension'),target,{recursive:true,filter:p=>!p.includes(path.sep+'test'+path.sep)});
  return target;
}
async function chooseFile(options){const result=await dialog.showOpenDialog(win,options);return result.canceled?null:result.filePaths;}
function uiState(){
  const state=factory.getState();state.appVersion=app.getVersion();state.automationMode='playwright';state.automation=automation?.status()||{mode:'playwright',running:false,profiles:{}};
  for(const account of state.accounts){account.paired=false;account.profileCreated=Boolean(state.automation.profiles?.[account.id]);account.browserReady=Boolean(state.automation.verified?.[account.id]);account.connected=account.browserReady;delete account.bridgeError;}
  return state;
}
async function request(action,payload={}){
  if(action==='state')return uiState();
  if(action==='pickQueue'){
    const files=await chooseFile({title:'Очередь ACE-Step',properties:['openFile'],filters:[{name:'JSON',extensions:['json']}]});
    if(!files)return {cancelled:true}; const queue=JSON.parse(fs.readFileSync(files[0],'utf8'));return factory.action('importQueue',{queue,accountId:payload.accountId});
  }
  if(action==='pickAudio'){
    const files=await chooseFile({title:'Добавить готовые треки',properties:['openFile','multiSelections'],filters:[{name:'Audio',extensions:['wav','mp3','flac','m4a','ogg']}]});
    return files?factory.action('importAudio',{paths:files,accountId:payload.accountId||'bos'}):{cancelled:true};
  }
  if(action==='chooseAcePath'){
    const files=await chooseFile({title:'Папка ACE-Step-1.5',properties:['openDirectory']});
    return files?factory.action('settings',{acePath:files[0]}):{cancelled:true};
  }
  if(action==='bridgePair'){
    throw new Error('Chrome Bridge больше не используется. Открой отдельный браузер Factory и войди один раз.');
  }
  if(action==='openAutomationProfile')return automation.openLogin(payload.accountId);
  if(action==='verifyAutomationProfile')return automation.verifyLogin(payload.accountId);
  if(action==='closeAutomationProfile')return automation.close(payload.accountId);
  if(action==='openExtensionFolder'){
    const target=syncExtensionFiles();
    const result=await shell.openPath(target);if(result)throw new Error(result);return {path:target};
  }
  if(action==='openChrome')return openChrome(payload.accountId,Boolean(payload.extensions));
  if(action==='copy'){clipboard.writeText(String(payload.text||''));return {ok:true};}
  if(action==='audioUrl'){factory.audioPath(payload.trackId);return `http://127.0.0.1:${bridge.port}/audio/${encodeURIComponent(payload.trackId)}?token=${bridge.token}`;}
  if(action==='revealTrack'){shell.showItemInFolder(factory.audioPath(payload.trackId));return {ok:true};}
  if(action==='openLogs'){const error=await shell.openPath(dataDir);if(error)throw new Error(error);return {ok:true};}
  if(action==='exportBackup'){
    const files=await chooseFile({title:'Куда сохранить переносимую копию фермы',properties:['openDirectory','createDirectory']});
    return files?factory.action('exportBackup',{directory:files[0]}):{cancelled:true};
  }
  if(action==='importBackup'){
    const files=await chooseFile({title:'Резервная копия Music Factory',properties:['openFile'],filters:[{name:'Factory JSON',extensions:['json']}]});
    return files?factory.action('importBackup',{file:files[0]}):{cancelled:true};
  }
  if(action==='exportQueue'){
    const result=await dialog.showSaveDialog(win,{title:'Экспорт очереди',defaultPath:'music-factory-queue.json',filters:[{name:'JSON',extensions:['json']}]});if(result.canceled)return {cancelled:true};
    const state=factory.getState();const tracks=state.tracks.filter(t=>!payload.trackIds?.length||payload.trackIds.includes(t.id));
    const queue=tracks.filter(t=>t.input||t.generation).map(t=>({...t.input,...t.generation,release_title:t.title,target_account:state.accounts.find(a=>a.id===t.accountId)?.handle,output_name:t.id}));
    fs.writeFileSync(result.filePath,JSON.stringify(queue,null,2));return {path:result.filePath};
  }
  if(action==='diagnostics')return {platform:process.platform,arch:process.arch,version:app.getVersion(),dataDir,bridgePort:bridge.port,chrome: (()=>{try{return chromeBinary();}catch{return null;}})(),automation:automation.status(),state:factory.getState(),liveSoundCloudVerified:false};
  if(action==='openExternal'){
    const url=new URL(payload.url);if(url.protocol!=='https:'||!['soundcloud.com','artists.soundcloud.com','help.soundcloud.com','github.com'].includes(url.hostname))throw new Error('Недопустимая ссылка');await shell.openExternal(url.href);return {ok:true};
  }
  const result=await factory.action(action,payload);
  broadcast();
  if(Array.isArray(result?.tracks)&&Array.isArray(result?.accounts))return uiState();
  if(Array.isArray(result?.state?.tracks))return {...result,state:uiState()};
  return result;
}
function broadcast(){if(win&&!win.isDestroyed())win.webContents.send('factory:state',uiState());}
async function start(){
  const {Factory}=require('./core/index.cjs');
  const packagedSeed=path.join(process.resourcesPath,'seed-batches','publish_manifest.json');
  const localSeed=path.join(__dirname,'..','public_upload_batches','us_2026_09_08','publish_manifest.json');
  factory=new Factory(dataDir,{seedManifest:fs.existsSync(packagedSeed)?packagedSeed:localSeed,resourcesDir:__dirname,onEvent:broadcast});
  const {SoundCloudPlaywright}=require('./core/playwright-runner.cjs');
  automation=new SoundCloudPlaywright({dataDir,factory,log,onEvent:broadcast,chromeExecutable:chromeBinary()});
  bridge=await startServer({factory,dataDir,uiDir:path.join(__dirname,'ui'),action:request,bridgeJobsEnabled:false,port:smoke?0:8788,onFocus:()=>{if(win){if(win.isMinimized())win.restore();win.show();win.focus();}return {ok:true};}});
  ipcMain.handle('factory:request',(event,action,payload)=>{if(event.sender!==win?.webContents)throw new Error('Unknown sender');return request(action,payload);});
  win=new BrowserWindow({width:1440,height:960,minWidth:920,minHeight:640,title:'Music Factory',backgroundColor:'#111319',show:false,autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
  win.webContents.setWindowOpenHandler(({url})=>{request('openExternal',{url}).catch(e=>log(e.message));return {action:'deny'};});
  const entryURL=pathToFileURL(path.join(__dirname,'ui','index.html')).href;
  win.webContents.on('will-navigate',(event,url)=>{if(url.split('#')[0]!==entryURL)event.preventDefault();});
  win.webContents.on('render-process-gone',(_event,details)=>handleError(new Error(`Окно приложения остановилось: ${details.reason}`)));
  win.webContents.on('did-fail-load',(_event,code,description)=>handleError(new Error(`Не удалось открыть интерфейс: ${code} ${description}`)));
  await win.loadFile(path.join(__dirname,'ui','index.html'));win.show();
  Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'Music Factory',submenu:[{role:'about'},{type:'separator'},{label:'Показать журнал',click:()=>shell.openPath(dataDir)},{role:'quit'}]},{role:'editMenu'},{role:'viewMenu'}]));
  log(`Started ${app.getVersion()} ${process.platform}/${process.arch}`);
  timer=setInterval(()=>{
    broadcast();
    const state=factory.getState();if(state.paused)return;
    const job=state.jobs.find(j=>j.status==='queued');
    if(job&&['publish','monetize'].includes(job.type)&&!automationBusy){
      automationBusy=true;factory.noteDispatch?.(job.id);
      automation.runQueued(job.accountId).catch(error=>log(error.stack||error.message)).finally(()=>{automationBusy=false;broadcast();});
    }
  },2000);
  if(smoke){log('SMOKE window loaded successfully');setTimeout(()=>app.quit(),1200);}
}
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',()=>{quitting=true;clearInterval(timer);automation?.closeAll().catch(()=>{});bridge?.server.close();factory?.close();});
