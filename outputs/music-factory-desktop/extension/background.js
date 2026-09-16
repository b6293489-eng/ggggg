'use strict';
importScripts('core.js');
const F = FactoryBridge;
const CHUNK = 512 * 1024;
const BRIDGE_REVISION = 'playwright-primary-v1';
const CONTENT_REVISION = 'upload-control-v5';
const BRIDGE_BUILD = 'legacy-extension-disabled-v1';
let polling = false, messageChain = Promise.resolve();
chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'}).catch(() => {});
const read = async () => chrome.storage.local.get(['config', 'active', 'attempted', 'connection', 'pendingReport']);
const write = value => chrome.storage.local.set(value);
async function api(config, path, payload) {
  const result = await fetch(`http://127.0.0.1:8788${path}`, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: {Authorization: `Bearer ${config.token}`, 'X-Music-Factory-Bridge-Version':chrome.runtime.getManifest().version,
      'X-Music-Factory-Bridge-Revision':BRIDGE_REVISION,
      ...(payload === undefined ? {} : {'Content-Type': 'application/json'})},
    body: payload === undefined ? undefined : JSON.stringify({accountId: config.accountId, ...payload}),
    signal: AbortSignal.timeout(20000), cache: 'no-store'
  });
  if (!result.ok) {
    const detail = await result.json().catch(() => ({}));
    throw new Error(detail.error || detail.message || `Factory: HTTP ${result.status}`);
  }
  return result.status === 204 ? null : result.json();
}
async function report(payload, terminal = false) {
  const state = await read();
  if (!state.config || !state.active) throw new Error('Нет активного подключения.');
  const full = {reportId: crypto.randomUUID(), jobId: state.active.job.id, ...payload};
  // This durable outbox is written before the request and any subsequent side effect.
  await write({pendingReport: {payload: full, terminal}});
  await flushReport();
}
async function flushReport() {
  const state = await read();
  if (!state.pendingReport || !state.config) return;
  const pending = state.pendingReport;
  await api(state.config, '/bridge/report', pending.payload);
  const next = {pendingReport: null};
  if (pending.terminal) {
    next.active = null;
    next.attempted = [...new Set([...(state.attempted || []), pending.payload.jobId])].slice(-200);
  }
  await write(next);
}
async function blocked(message) {
  const {active} = await read();
  if (!active) return;
  const affected = active.sideEffect ? F.afterSideEffect(active.results || active.job.tracks) : (active.results || []);
  await report({status: 'blocked', message, tracks: affected, safeToRetry: !active.sideEffect}, true);
}
async function tick() {
  if (polling) return;
  polling = true;
  try {
    await flushReport();
    let state = await read();
    if (!state.config) return;
    await api(state.config, '/bridge/heartbeat', {version: chrome.runtime.getManifest().version, build: BRIDGE_BUILD,
      observedHandle: state.connection?.observedHandle || null, activeJobId: state.active?.job.id || null});
    await write({connection: {...state.connection, connected: true, checkedAt: Date.now(), error: null}});
    if (state.active) {
      if (Date.now() - state.active.lastSeen > 150000) {
        await blocked('Связь с вкладкой прервалась. Проверь SoundCloud перед повторным запуском; автоматический повтор отключён.');
      }
      return;
    }
    const response = await api(state.config, `/bridge/job?accountId=${encodeURIComponent(state.config.accountId)}`);
    const job = response?.job ?? response;
    if (!job?.id) return;
    try { F.validateJob(job, state.config); }
    catch(e) { await api(state.config, '/bridge/report', {jobId:job.id,status:'blocked',message:e.message,tracks:[],safeToRetry:true}); return; }
    if ((state.attempted || []).includes(job.id)) {
      await api(state.config, '/bridge/report', {jobId:job.id,status:'blocked',message:'Это задание уже запускалось в Chrome. Проверь результат перед созданием нового задания.',tracks:[],safeToRetry:false});
      return;
    }
    const paired=true;
    // Keep the existing SoundCloud document from consuming the job while its tab is being sent to the uploader.
    await write({active: {job, phase:'navigating', lastSeen:Date.now(), sideEffect:false, results:[], tabId:null},
      connection:{...state.connection,observedHandle:null}});
    await report({status:'progress',message:'Открываю задание в профиле Chrome, подключённом пользователем.',tracks:[]});
    let tab;
    const [currentTab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (currentTab && currentTab.url && (currentTab.url.includes('soundcloud.com/upload') || currentTab.url.includes('soundcloud.com'))) {
      tab = currentTab;
    } else {
      tab = await chrome.tabs.create({url:'about:blank', active:true});
    }
    state = await read();
    await write({active:{...state.active,tabId:tab.id,lastSeen:Date.now()}});
    const targetUrl=job.type==='publish'?'https://soundcloud.com/upload':'https://artists.soundcloud.com/monetization';
    // Updating an already-open tab to its current URL may leave its old content script alive.
    // A real reload guarantees that content.js and background.js are from the same Bridge build.
    if(tab.url&&new URL(tab.url).origin+new URL(tab.url).pathname===targetUrl){
      await chrome.tabs.reload(tab.id);
    }else{
      await chrome.tabs.update(tab.id,{url:targetUrl});
    }
  } catch(e) {
    const state = await read();
    await write({connection:{...state.connection,connected:false,error:e.message,checkedAt:Date.now()}});
  } finally { polling = false; }
}
function trustedPopup(sender) { return !sender.tab && sender.url === chrome.runtime.getURL('popup.html'); }
async function trustedContent(sender) {
  let state = await read();
  let url; try { url = new URL(sender.url); } catch (_) { throw new Error('Источник недоступен.'); }
  if (sender.id !== chrome.runtime.id || !state.active || url.protocol !== 'https:' ||
      !['soundcloud.com','artists.soundcloud.com'].includes(url.hostname) || sender.frameId !== 0) {
    throw new Error('Эта вкладка не выполняет задание Factory.');
  }
  if(sender.tab?.id!==state.active.tabId){
    const active=state.active,expectedWindow=active.expectedWindowId;
    const mayAdopt=active.job.type==='publish'&&!active.sideEffect&&!active.uploadTabCreated&&active.expectUploadTabAt&&
      Date.now()-active.expectUploadTabAt<60000&&url.hostname==='soundcloud.com'&&url.pathname.startsWith('/upload')&&
      (expectedWindow==null||sender.tab?.windowId===expectedWindow);
    if(!mayAdopt)throw new Error('Эта вкладка не выполняет задание Factory.');
    const previousTabId=active.tabId;
    const adopted={...active,phase:'ready',tabId:sender.tab.id,documentId:null,url:null,lastSeen:Date.now(),uploadTabCreated:true,
      expectUploadTabAt:null,openingUploadTabAt:null,expectedWindowId:null};
    await write({active:adopted});state={...state,active:adopted};
    if(previousTabId!==sender.tab.id)await chrome.tabs.remove(previousTabId).catch(()=>{});
  }
  return state;
}
async function audioChunk(state, message) {
  const track = state.active.job.tracks.find(t => t.id === message.trackId);
  const offset = message.offset;
  if (!track || state.active.phase !== 'dispatched' || state.active.job.type !== 'publish' ||
      !Number.isSafeInteger(offset) || offset < 0 || offset > 1024*1024*1024) throw new Error('Недопустимый запрос аудио.');
  const response = await fetch(`http://127.0.0.1:8788/bridge/audio/${encodeURIComponent(track.id)}`, {
    headers:{Authorization:`Bearer ${state.config.token}`, Range:`bytes=${offset}-${offset+CHUNK-1}`,
      'X-Music-Factory-Bridge-Version':chrome.runtime.getManifest().version,
      'X-Music-Factory-Bridge-Revision':BRIDGE_REVISION},
    signal:AbortSignal.timeout(20000),cache:'no-store'
  });
  if (response.status !== 206) throw new Error(`Factory не передала фрагмент аудио (HTTP ${response.status}). Обнови сервер и расширение вместе.`);
  const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('Content-Range') || '');
  if (!range || Number(range[1]) !== offset || Number(range[2])-offset+1 > CHUNK || Number(range[3]) > 1024*1024*1024) throw new Error('Неверный диапазон аудио.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length !== Number(range[2])-offset+1) throw new Error('Фрагмент аудио повреждён.');
  let binary=''; for(let i=0;i<bytes.length;i+=8192) binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
  return {data:btoa(binary),offset,total:Number(range[3]),length:bytes.length};
}
async function onMessage(message, sender) {
  if (message.type?.startsWith('popup.')) {
    if (!trustedPopup(sender)) throw new Error('Неверный источник запроса.');
    const state = await read();
    if (message.type === 'popup.pair') {
      if (state.active) throw new Error('Дождись завершения активного задания перед сменой аккаунта.');
      const config = F.validateConfig(message);
      await api(config,'/bridge/heartbeat',{version:chrome.runtime.getManifest().version,build:BRIDGE_BUILD});
      await write({config,connection:{connected:true,checkedAt:Date.now()},attempted:state.attempted || []});
      await tick(); return {};
    }
    if (message.type === 'popup.disconnect') {
      if (state.active) throw new Error('Сначала останови или заверши активное задание в Factory.');
      await write({config:null,connection:null}); return {};
    }
    if (message.type === 'popup.check') { await tick(); return {}; }
    if (message.type === 'popup.focus') {
      if (!state.config) throw new Error('Сначала запусти Music Factory.app / Music Factory.exe и подключи этот профиль кодом из приложения.');
      try { await api(state.config, '/bridge/focus', {}); }
      catch (_) { throw new Error('Не удалось открыть Factory. Запусти Music Factory.app / Music Factory.exe. Если она уже запущена, проверь код подключения этого профиля.'); }
      return {};
    }
    if (message.type === 'popup.status') {
      const c=state.connection;
      return {accountId:state.config?.accountId,connected:!!c?.connected,
        message: !state.config ? 'Ожидает код подключения.' : state.active ? `Подключено: ${state.config.accountId}. ${state.active.phase === 'verifying' ? 'Проверка аккаунта' : 'Задание выполняется'}.` :
          c?.connected ? `Профиль подключён: ${state.config.accountId}. ${c.observedHandle ? 'Последняя DOM-проверка: @'+c.observedHandle+'.' : 'Задания используют профиль, выбранный при подключении.'}` :
          `Factory недоступна. Запусти приложение. ${c?.error || ''}`};
    }
    throw new Error('Неизвестная команда.');
  }
  const state=await trustedContent(sender), active=state.active;
  await write({active:{...active,lastSeen:Date.now()}});
  if (message.type === 'content.ready') {
    if(message.contentRevision!==CONTENT_REVISION){
      throw new Error('В этой вкладке был старый скрипт Bridge. Factory перезагрузит SoundCloud перед следующим повтором.');
    }
    if (active.phase === 'verifying') return {verify:{id:active.job.id,handle:active.job.handle}};
    const readyUrl=new URL(sender.url);
    const correct = active.job.type === 'publish'
      ? (readyUrl.hostname==='soundcloud.com' && (readyUrl.pathname==='/artists' || readyUrl.pathname==='/upload' || readyUrl.pathname.startsWith('/artists') || readyUrl.pathname.startsWith('/upload')))
      : (readyUrl.hostname==='artists.soundcloud.com' && readyUrl.pathname.startsWith('/monetization'));
    // chrome.tabs.update is asynchronous. The old /discover document can announce itself before navigation commits.
    // Ignore it; only the destination document may receive the job.
    if(active.phase==='navigating'&&!correct)return {};
    const isNewDocument = sender.documentId ? sender.documentId !== active.documentId : (sender.url && active.url && sender.url !== active.url);
    if (active.phase === 'navigating' || active.phase === 'ready' || (active.phase === 'dispatched' && !active.sideEffect && isNewDocument)) {
      if (!correct) throw new Error('Открылась неожиданная страница SoundCloud: ' + readyUrl.pathname);
      await write({active:{...active,phase:'dispatched',documentId:sender.documentId,url:sender.url,lastSeen:Date.now(),
        uploadTabCreated:active.uploadTabCreated||!!active.expectUploadTabAt,expectUploadTabAt:null,expectedWindowId:null}});
      return {job:active.job};
    }
    // New document after upload navigation may inspect results, but never upload again.
    return {inspect:active.job,sideEffect:active.sideEffect};
  }
  if (message.type === 'content.verified') {
    if (active.phase!=='verifying' || message.handle!==active.job.handle.toLowerCase()) {
      await blocked(`Ожидался @${active.job.handle}; текущий аккаунт: ${message.handle || 'не определён'}.`);return {};
    }
    await write({connection:{...state.connection,observedHandle:message.handle},active:{...active,phase:'ready',lastSeen:Date.now()}});
    await chrome.tabs.update(active.tabId,{url:active.job.type==='publish' ? 'https://soundcloud.com/artists' : 'https://artists.soundcloud.com/monetization'});
    return {};
  }
  if (message.type === 'content.ping') return {continue:true};
  if (message.type === 'content.expectUploadTab') {
    if(active.job.type!=='publish'||active.sideEffect)throw new Error('Нельзя менять вкладку после начала передачи файлов.');
    if(active.uploadTabCreated)throw new Error('SoundCloud снова показал главную страницу вместо загрузчика. Новые вкладки больше не открываются.');
    await write({active:{...active,phase:'ready',documentId:null,url:null,lastSeen:Date.now(),expectUploadTabAt:Date.now(),
      expectedWindowId:sender.tab?.windowId??null}});
    return {};
  }
  if (message.type === 'content.openUploadTab') {
    if(active.job.type!=='publish'||active.sideEffect)throw new Error('Нельзя менять вкладку после начала передачи файлов.');
    if(active.uploadTabCreated||active.openingUploadTabAt)throw new Error('Вкладка загрузки для этого задания уже открывается.');
    let target='https://soundcloud.com/upload';
    try{const parsed=new URL(message.url,'https://soundcloud.com');if(parsed.hostname==='soundcloud.com'&&parsed.pathname.startsWith('/upload'))target=parsed.href;}catch(_){}
    const armed={...active,phase:'ready',documentId:null,url:null,lastSeen:Date.now(),expectUploadTabAt:Date.now(),openingUploadTabAt:Date.now(),
      expectedWindowId:sender.tab?.windowId??null};
    await write({active:armed});
    await chrome.tabs.create({url:target,active:true,...(sender.tab?.windowId==null?{}:{windowId:sender.tab.windowId})});
    return {};
  }
  if (message.type === 'content.navigate') {
    let target = 'https://soundcloud.com/upload';
    try {
      const parsed = new URL(message.url, 'https://soundcloud.com');
      if (['soundcloud.com', 'artists.soundcloud.com'].includes(parsed.hostname)) {
        target = parsed.href;
      }
    } catch (_) {}
    await chrome.tabs.update(active.tabId, { url: target });
    return { ok: true };
  }
  if (message.type === 'content.audio') return audioChunk(state,message);
  if (message.type === 'content.report') {
    if (active.documentId && sender.documentId && sender.documentId !== active.documentId && message.payload?.status !== 'progress') {
      return {};
    }
    const p=message.payload;
    if (!['progress','complete','failed','blocked'].includes(p?.status) || !Array.isArray(p.tracks)) throw new Error('Неверный отчёт.');
    const permitted = new Set(active.job.tracks.map(t=>t.id));
    const statuses=new Set(['published','submitted','monetizing','rejected','failed','uncertain','uploading','submitting']);
    if (new Set(p.tracks.map(t=>t.id)).size!==p.tracks.length || p.tracks.some(t=>!permitted.has(t.id) || !statuses.has(t.status) ||
        (t.publishUrl && !F.trackUrl(t.publishUrl,active.job.handle)))) throw new Error('Неверный трек в отчёте.');
    if (p.status==='complete') {
      const done=active.job.type==='publish'?new Set(['published']):new Set(['submitted','monetizing','rejected']);
      if(p.tracks.length!==active.job.tracks.length || p.tracks.some(t=>!done.has(t.status)||!F.trackUrl(t.publishUrl,active.job.handle))) {
        throw new Error('Завершение без подтверждённого результата каждого трека запрещено.');
      }
    }
    const sideEffect=active.sideEffect || p.tracks.some(t=>['uploading','submitting','published','submitted','monetizing','uncertain'].includes(t.status));
    const results = [...(active.results || [])];
    for(const t of p.tracks) {const i=results.findIndex(x=>x.id===t.id);if(i<0)results.push(t);else results[i]=t;}
    await write({active:{...active,sideEffect,results,lastSeen:Date.now()}});
    const terminal=p.status!=='progress';
    await report({...p,safeToRetry:!sideEffect},terminal);
    if(terminal) await chrome.action.setBadgeText({text:p.status==='complete'?'✓':'!'});
    return {};
  }
  throw new Error('Неизвестная команда.');
}
chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{
  // Serialize messages so a concurrent heartbeat cannot overwrite a persisted side-effect checkpoint.
  const request=messageChain.then(()=>onMessage(message,sender));
  messageChain=request.catch(()=>{});
  request.then(result=>sendResponse({ok:true,...result})).catch(e=>sendResponse({ok:false,error:e.message}));
  return true;
});
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='factory-poll')tick();});
async function recoverUploadHandoff(){
  const {active}=await read();
  if(!active||active.job.type!=='publish'||active.sideEffect||active.uploadTabCreated||!active.expectUploadTabAt||active.openingUploadTabAt)return;
  const armed={...active,lastSeen:Date.now(),expectUploadTabAt:Date.now(),openingUploadTabAt:Date.now()};
  await write({active:armed});
  await chrome.tabs.create({url:'https://soundcloud.com/upload',active:true,...(active.expectedWindowId==null?{}:{windowId:active.expectedWindowId})});
}
async function initialize() {await chrome.alarms.create('factory-poll',{periodInMinutes:0.5});await recoverUploadHandoff();await tick();}
chrome.runtime.onInstalled.addListener(initialize);
chrome.runtime.onStartup.addListener(initialize);
chrome.tabs.onRemoved.addListener(async tabId=>{const {active}=await read();if(active?.tabId===tabId)blocked('Вкладка SoundCloud закрыта. Проверь результат перед повторным запуском.').catch(()=>{});});
