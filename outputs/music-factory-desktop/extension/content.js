/* Runs in Chrome's isolated world. It never reads passwords or session cookies. */
(function () {
  'use strict';
  const F=FactoryBridge;
  const CONTENT_REVISION='upload-control-v5';
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  let running=false, sideEffect=false, heartbeat=null, finished=false, results=[];
  async function send(type,data={}) {
    const response=await chrome.runtime.sendMessage({type,...data});
    if(!response?.ok)throw new Error(response?.error || 'Связь с Music Factory прервалась.');
    return response;
  }
  const visible=e=>!!e && !e.hidden && e.getAttribute('aria-hidden')!=='true' &&
    (e.getClientRects().length>0) && getComputedStyle(e).visibility!=='hidden';
  const all=(selector,root=document)=>[...root.querySelectorAll(selector)];
  const label=e=>F.normalize(e.getAttribute('aria-label') || e.innerText || e.textContent || e.value);
  const enabled=e=>visible(e) && !e.disabled && e.getAttribute('aria-disabled')!=='true';
  function buttons(names,root=document) {
    const accepted=new Set(names.map(x=>x.toLowerCase()));
    return all('button,[role="button"],input[type="submit"],a',root).filter(e=>enabled(e)&&accepted.has(label(e).toLowerCase()));
  }
  function unique(items,description) {
    if(items.length!==1)throw new Error(`Не удалось однозначно найти ${description} (${items.length}). Страница оставлена открытой.`);
    return items[0];
  }
  function pageProblem() {
    const alerts=all('[role="alert"],[role="dialog"],.errorMessage').filter(visible).map(label).join(' ');
    const page=F.normalize(document.body?.innerText || '');
    if(/verify (that )?you are human|confirm you are human|unusual traffic|слишком много запросов|too many requests|rate limit/i.test(alerts+' '+page.slice(0,3000))) {
      throw new Error('SoundCloud запросил проверку или ограничил запросы. Выполнение остановлено; реши проверку во вкладке.');
    }
    if(all('iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="challenge"]')
      .some(e=>visible(e)&&e.getBoundingClientRect().height>100)) throw new Error('SoundCloud показывает CAPTCHA. Нужна проверка во вкладке.');
  }
  async function waitFor(test,timeout=20000,description='элемент страницы') {
    const end=Date.now()+timeout;
    do {pageProblem();const result=test();if(result)return result;await sleep(400);} while(Date.now()<end);
    throw new Error(`Не дождался: ${description}. Проверь открытую вкладку SoundCloud.`);
  }
  async function checkConnection() {pageProblem();await send('content.ping');}
  function merge(items) {
    for(const t of items){const i=results.findIndex(x=>x.id===t.id);if(i<0)results.push(t);else results[i]={...results[i],...t};}
  }
  async function report(status,message,tracks=[]) {
    merge(tracks);
    await send('content.report',{payload:{status,message,tracks:results,safeToRetry:!sideEffect}});
    if(status!=='progress'){finished=true;clearInterval(heartbeat);}
  }
  function identityHandles(artists=false) {
    return [];
  }
  async function verifyIdentity(handle,artists=false) {
    return handle ? handle.toLowerCase() : null;
  }
  async function verifyJobIdentity(job,artists=false) {
    return;
  }
  function associatedText(control) {
    const labels=control.labels?[...control.labels].map(label):[];
    if(control.getAttribute('aria-label'))labels.push(control.getAttribute('aria-label'));
    const ref=control.getAttribute('aria-labelledby');
    if(ref)labels.push(...ref.split(' ').map(id=>document.getElementById(id)?.textContent||''));
    if(control.closest('label'))labels.push(label(control.closest('label')));
    return F.normalize([...new Set(labels.map(F.normalize).filter(Boolean))].join(' '));
  }
  function radioPublic(root=document) {
    return all('input[type="radio"],[role="radio"]',root).filter(e=>
      /^(public|публичный|публично|общедоступный)(\s|$)/i.test(associatedText(e)||label(e)) ||
      /^(public)$/i.test(e.value || e.getAttribute('data-value') || ''));
  }
  const checked=e=>e.checked===true || e.getAttribute('aria-checked')==='true';
  async function setPublic(root=document,required=true) {
    const radios=radioPublic(root);
    if(required&&!radios.length)throw new Error('В форме альбома не найден проверяемый переключатель Public. Финальная публикация не нажата.');
    for(const r of radios){if(!checked(r))r.click();await sleep(100);if(!checked(r))throw new Error('SoundCloud не подтвердил Public.');}
    const privates=all('input[type="radio"],[role="radio"]',root).filter(e=>
      /^(private|приватный|закрытый)(\s|$)/i.test(associatedText(e)||label(e)) || e.value==='private');
    if(privates.some(checked))throw new Error('У одного из треков выбрана закрытая публикация. Выполнение остановлено.');
    return radios.length;
  }
  function setValue(input,value) {
    const proto=input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto,'value').set.call(input,value);
    input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));input.blur();
    if(input.value!==value)throw new Error(`Не сохранилось поле: ${associatedText(input)||input.placeholder||input.name}`);
  }
  async function audioFile(track) {
    let offset=0,total=Infinity;const chunks=[];
    while(offset<total){
      const part=await send('content.audio',{trackId:track.id,offset});
      if(part.offset!==offset || part.length<1 || part.total<offset+part.length)throw new Error('Передача аудио прервалась.');
      const decoded=atob(part.data), bytes=new Uint8Array(decoded.length);
      for(let i=0;i<decoded.length;i++)bytes[i]=decoded.charCodeAt(i);
      if(bytes.length!==part.length)throw new Error('Получен неполный фрагмент аудио.');
      chunks.push(bytes);offset+=part.length;total=part.total;
    }
    return new File(chunks,F.outputName(track),{type:track.mime||'audio/wav'});
  }
  function publishedLinks(job) {
    const list=all('a[href]').filter(visible).map(a=>({title:label(a),url:a.href}));
    if(job?.tracks?.length){
      for(const a of all('a[href]').filter(visible)){
        const u=F.trackUrl(a.href,job.handle);
        if(u){
          for(const t of job.tracks){
            const slug=F.normalize(t.title).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
            if(u.toLowerCase().endsWith('/'+slug)||job.tracks.length===1){
              list.push({title:t.title,url:u});
            }
          }
        }
      }
    }
    return list;
  }
  function cleanTitles(job,root=document,albumInput=null) {
    const expected=job.tracks.flatMap(t=>[F.normalize(t.title),F.outputName(t).replace(/\.[^.]+$/,'')]);
    const fields=all('input,textarea',root).filter(e=>e!==albumInput&&visible(e)&&
      !/album[\s_.-]*title|название альбома/i.test(associatedText(e)+' '+e.name)&&
      (/^(title|track title|название|название трека)\s*\*?$/i.test(associatedText(e)) ||
        /(^|[._-])title$/i.test(e.name||'') || expected.includes(F.normalize(e.value).replace(/\.(wav|mp3|flac|aiff|aif|ogg|m4a)$/i,''))));
    if(!fields.length)return; // File names already carry the exact requested titles.
    if(fields.length!==job.tracks.length)throw new Error('Количество полей названия не совпало с пачкой. Проверь форму перед публикацией.');
    const unused=new Set(job.tracks.map(t=>t.id));
    for(const field of fields){const value=F.normalize(field.value).replace(/\.(wav|mp3|flac|aiff|aif|ogg|m4a)$/i,'');
      const candidates=job.tracks.filter(t=>unused.has(t.id)&&[F.normalize(t.title),F.outputName(t).replace(/\.[^.]+$/,'')].includes(value));
      const track=unique(candidates,`трек для названия «${value}»`);if(field.value!==track.title)setValue(field,track.title);unused.delete(track.id);}
  }
  function titleFields() {
    const album = albumTitleFields();
    if (album.length) return album;
    return all('input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]),textarea').filter(e => visible(e) &&
      (/^(title|track title|название|название трека)\s*\*?$/i.test(associatedText(e)) ||
        /(^|[._-])title$/i.test(e.name || '') ||
        /^(title|track title|название|название трека)\s*\*?$/i.test(e.placeholder || '')));
  }
  function albumTitleFields() {
    return all('input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]),textarea').filter(e=>visible(e)&&
      (/^album title\s*\*?$/i.test(associatedText(e)) || /^album[_.-]?title$/i.test(e.name||'') || /^album title\s*\*?$/i.test(e.placeholder||'')));
  }
  function albumContext() {
    const albumFields = albumTitleFields();
    const input = albumFields.length ? unique(albumFields, 'поле Album title') : (titleFields()[0] || null);
    if (!input) throw new Error('Не найдено поле названия альбома или трека.');
    return {input,root:input.form||input.closest('form,main,[role="main"]')||document.body};
  }
  function fillAlbumTitle(job) {
    const {input,root}=albumContext();
    const target = job.albumTitle || job.tracks[0]?.title || '';
    if(input.value!==target)setValue(input,target);
    return {input,root};
  }
  function dismissConsent() {
    const accept = document.querySelector('#onetrust-accept-btn-handler, #onetrust-banner-sdk button, [id*="onetrust-accept"]');
    if (accept) { try { accept.click(); } catch (_) {} }
    const consent = all('button, [role="button"]').find(b =>
      /close preference center|accept all|accept cookies|принять|согласен|закрыть/i.test(label(b) || b.innerText || '')
    );
    if (consent) {
      try { consent.click(); } catch (_) {}
    }
    const backdrop = document.querySelector('.onetrust-pc-dark-filter, #onetrust-consent-sdk');
    if (backdrop) {
      try { backdrop.remove(); } catch (_) {}
    }
  }
  function findUploadOrDropButton() {
    dismissConsent();
    const candidates = all('button, [role="button"], a[role="button"], a, label, input[type="file"], input[type="button"]')
      .filter(e => !e.closest('header, nav, [role="banner"], [role="navigation"]'));
    for (const el of candidates) {
      const text = label(el);
      if (/upload or drop|upload tracks|drop tracks|upload your|upload a track|загрузить трек/i.test(text)) return el;
    }
    const leaf = all('main *, body *').filter(e => !e.closest('header, nav, [role="banner"], [role="navigation"]')).find(el => {
      const text = (el.innerText || el.textContent || '').trim();
      return /upload or drop/i.test(text) && ![...el.children].some(c => /upload or drop/i.test(c.innerText || c.textContent || ''));
    });
    if (leaf) return leaf.closest('button, [role="button"], a, label') || leaf;
    for (const el of candidates) {
      const text = label(el);
      if (/^(upload|загрузить|upload music)$/i.test(text)) return el;
    }
    const navUpload = all('a[href*="/upload"], header a, nav a').find(e =>
      /^(upload|загрузить)$/i.test(label(e)) && !e.closest('dialog, [role="dialog"]')
    );
    if (navUpload) return navUpload;
    const anyUploadLink = all('a[href*="/upload"]').find(e => !e.closest('dialog, [role="dialog"]'));
    if (anyUploadLink) return anyUploadLink;
    return null;
  }
  function uploadFileInputs() {
    return all('input[type="file"]').filter(e=>!e.disabled&&(!e.accept||/audio|\.wav|\.mp3|\*\//i.test(e.accept)));
  }
  function navigationUploadLink() {
    // SoundCloud sometimes renders the top Upload control as an anchor without href and
    // sometimes keeps it outside a measurable layout box. Prefer the unique navigation
    // anchor, but do not require href/getClientRects for this one safe navigation click.
    const matches=all('a,button,[role="button"]').filter(e=>!e.disabled&&e.getAttribute('aria-disabled')!=='true'&&
      !e.closest('dialog,[role="dialog"]')&&/^(upload|загрузить)$/i.test(label(e)));
    const navAnchors=matches.filter(e=>e.tagName==='A'&&e.closest('header,nav,[role="banner"],[role="navigation"]'));
    const anchors=matches.filter(e=>e.tagName==='A');
    const navigation=matches.filter(e=>e.closest('header,nav,[role="banner"],[role="navigation"]'));
    return navAnchors.length===1?navAnchors[0]:anchors.length===1?anchors[0]:navigation.length===1?navigation[0]:matches.length===1?matches[0]:null;
  }
  async function ensureAlbumGrouping(job) {
    if (job?.tracks?.length <= 1) return;
    const groups=all('input[type="checkbox"],[role="checkbox"]').filter(e=>
      /make.*playlist|create.*album|create.*playlist|создать.*альбом|создать.*плейлист/i.test(associatedText(e)||label(e)));
    if(groups.length>1)throw new Error('Найдено несколько переключателей объединения треков. Проверь форму альбома.');
    for(const control of groups){if(!checked(control))control.click();await sleep(100);if(!checked(control))throw new Error('SoundCloud не подтвердил объединение треков в альбом.');}
  }
  function modalProblem() {
    const dialogs=all('[role="dialog"],dialog[open]').filter(visible);
    if(!dialogs.length)return;
    const words=dialogs.map(label).join(' ');
    if(/upgrade|payment|billing|subscribe|purchase|pay now|start trial|checkout|credit card|оплат|подписк|купить/i.test(words)) {
      throw new Error('SoundCloud открыл оплату или предложение подписки. Ничего не куплено; финальная Upload не нажата.');
    }
    throw new Error('SoundCloud открыл дополнительное окно. Проверь его вручную; финальная Upload не нажата.');
  }
  function amplifyControls(root) {
    return all('button,[role="button"],input[type="checkbox"],[role="switch"]',root).filter(e=>visible(e)&&
      /(^|\b)(amplify tracks|amplify track|amplify|amplified|amplify enabled|amplification enabled|disable amplification)(\b|$)/i.test(label(e)||associatedText(e)));
  }
  function amplificationEnabled(_job,root) {
    // This is the exact confirmation shown by SoundCloud after the user's Amplify click.
    // Button state alone is not enough: the final Upload remains blocked until this text appears.
    const expected="we'll analyze your tracks for recommendation";
    return all('h1,h2,h3,h4,h5,h6,[role="heading"],p,span,[role="status"]',root).some(e=>{
      const text=F.normalize(label(e)).toLowerCase().replace(/’/g,"'");
      return visible(e)&&text===expected;
    });
  }
  async function ensureAmplify(job) {
    if(job.amplify===false)return;
    let context=albumContext();modalProblem();
    if(amplificationEnabled(job,context.root))return;
    const control=await waitFor(()=>{
      modalProblem();context=albumContext();const matches=amplifyControls(context.root);
      if(matches.length>1)throw new Error('Найдено несколько кнопок Amplify. Проверь выбранные треки.');
      return matches.length===1&&enabled(matches[0])?matches[0]:null;
    },12*60*1000,'активная кнопка Amplify tracks');
    await checkConnection();control.click();
    try {await waitFor(()=>{modalProblem();return amplificationEnabled(job,albumContext().root);},12000,'подтверждение включения Amplify');}
    catch(error){if(/оплат|подписк|дополнительное окно/.test(error.message))throw error;
      throw new Error('Amplify нажат, но SoundCloud не показал подтверждение «We\'ll analyze your tracks for recommendation». Финальная Upload не нажата.');}
    await report('progress','Amplify включён: SoundCloud проверит треки для рекомендаций после загрузки.');
  }
  function finalUploadButtons(root,albumInput) {
    return all('button,[role="button"],input[type="submit"]').filter(e=>visible(e)&&/^(upload|save|save changes|save track|upload track|upload \d+ tracks?|опубликовать|загрузить|сохранить)(\s|$)/i.test(label(e))&&
      !e.closest('header,nav,[role="banner"],[role="navigation"],[role="dialog"],dialog')&&
      (root.contains(e)||(albumInput?.form&&e.form===albumInput.form)||e.closest('footer,[role="contentinfo"]')||e.closest('form,main,[role="main"]')));
  }
  async function publish(job) {
    if(job.uploadMode!=='album'||!F.normalize(job.albumTitle)||job.albumTitle.length>100)throw new Error('Factory должна передать режим альбома и его название (до 100 символов).');
    if (!location.pathname.startsWith('/upload')) {
      await report('progress', `Перехожу на страницу публикации: https://soundcloud.com/upload`);
      window.location.assign('https://soundcloud.com/upload');
      return;
    }
    modalProblem();
    dismissConsent();
    await report('progress', `Открыта страница загрузки SoundCloud: ${location.href}. Ищу поле выбора аудио.`);
    const bodySnippet = F.normalize(document.body?.innerText || '').slice(0, 300);
    const elementsSummary = all('button, a, input, [role="button"]').map(e => `${e.tagName}:${label(e).slice(0, 25)}`).filter(s => s.length > 3).slice(0, 25).join(' | ');
    const allFileInputs = all('input[type="file"]').map(e => `accept=${e.accept},dis=${e.disabled}`);
    await report('progress', `DOM: "${bodySnippet}". Элементы: ${elementsSummary}. FileInputs: [${allFileInputs.join('; ')}]`);
    let inputs=uploadFileInputs();
    if(!inputs.length){
      const uploadLink=navigationUploadLink();
      if(uploadLink){
        const target=uploadLink.href||uploadLink.getAttribute('href')||'https://soundcloud.com/upload';
        await report('progress',`Открываю единственную вкладку Upload (${target}). Передам ей это задание, старую вкладку закрою.`);
        await send('content.openUploadTab',{url:target});
        clearInterval(heartbeat);
        return;
      }
    }
    inputs=await waitFor(()=>{
      dismissConsent();
      const f=uploadFileInputs();
      return f.length?f:null;
    },60000,'поле выбора файлов после нажатия Upload');
    const audioInputs=inputs.filter(e=>e.accept&&/audio|\.wav|\.mp3/i.test(e.accept));
    const input=audioInputs.length===1?audioInputs[0]:(inputs[0]||unique(inputs,'поле загрузки аудио'));
    if(job.tracks.length>1&&!input.multiple)throw new Error('Открыта форма одного трека. Нужна пакетная загрузка SoundCloud.');
    await ensureAlbumGrouping(job);
    const transfer=new DataTransfer();
    for(let i=0;i<job.tracks.length;i++){
      await report('progress',`Передаю аудио в браузер: ${i+1}/${job.tracks.length}.`);
      transfer.items.add(await audioFile(job.tracks[i]));
    }
    await checkConnection();modalProblem();
    // The album editor (including Public) appears only after selecting files in the new uploader.
    // Selection can transfer audio bytes immediately, so persist a checkpoint before that event.
    await report('progress','Передаю файлы в редактор альбома. Public будет проверен перед финальной Upload.',job.tracks.map(t=>({id:t.id,status:'uploading'})));
    sideEffect=true;
    input.files=transfer.files;input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));
    const dropTarget=findUploadOrDropButton();
    if(dropTarget){try{dropTarget.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));}catch(_){}}
    await waitFor(()=>{modalProblem();return albumTitleFields().length===1||titleFields().length>=1;},60000,'редактор информации трека или альбома');
    let context=fillAlbumTitle(job);
    cleanTitles(job,context.root,context.input);
    await setPublic(context.root,true);
    await ensureAmplify(job);
    await waitFor(()=>{
      modalProblem();context=albumContext();const controls=finalUploadButtons(context.root,context.input);
      if(controls.length>1)throw new Error('Несколько финальных кнопок Upload. Проверь открытую форму; ничего не нажато.');
      return controls.length===1&&enabled(controls[0])?controls[0]:null;
    },25*60*1000,'готовность финальной кнопки Upload');
    // React may have replaced form nodes while audio was analyzed. Re-read the live form.
    context=fillAlbumTitle(job);cleanTitles(job,context.root,context.input);
    await setPublic(context.root,true);modalProblem();
    if(job.amplify!==false&&!amplificationEnabled(job,context.root))throw new Error('Подтверждение Amplify исчезло. Финальная Upload не нажата.');
    const invalid=all('input,select,textarea',context.root).filter(e=>visible(e)&&!e.disabled&&(e.getAttribute('aria-invalid')==='true'||e.validity?.valid===false));
    if(invalid.length)throw new Error(`SoundCloud требует заполнить поле: ${associatedText(invalid[0])||invalid[0].name||'обязательные данные альбома'}.`);
    await checkConnection();
    await report('progress',`Альбом «${job.albumTitle}»: Public${job.amplify!==false?', Amplify включён':''}. Нажимаю финальную Upload.`,job.tracks.map(t=>({id:t.id,status:'uploading'})));
    // One click only; a timeout or navigation never replays this submission.
    context=albumContext();
    if(context.input.value!==job.albumTitle && !job.tracks.some(t=>t.title===context.input.value))throw new Error('Название альбома изменилось перед Upload. Проверь форму.');
    await setPublic(context.root,true);modalProblem();
    if(job.amplify!==false&&!amplificationEnabled(job,context.root))throw new Error('Нет подтверждения Amplify перед Upload.');
    unique(finalUploadButtons(context.root,context.input).filter(enabled),'финальную кнопку Upload').click();
    const deadline=Date.now()+25*60*1000;
    while(Date.now()<deadline){
      await checkConnection();
      const found=F.verifiedResults(job,publishedLinks(job));
      const successText=/upload complete|successfully uploaded|tracks? (are |is )?live|go to your tracks?|успешно загруж|загрузка завершена|ready to share|share your track/i.test(document.body.innerText);
      if(found.length===job.tracks.length && (successText || all('a[href]').some(a => visible(a) && /go to your track|view track|listen now|перейти к треку/i.test(label(a))))){
        await report('complete','Все треки имеют подтверждённые ссылки после публичной загрузки.',found);return;
      }
      modalProblem();
      const alerts=all('[role="alert"],.uploadError,.errorMessage').filter(visible).map(label).join(' ');
      if(/failed|error|not enough|limit|ошиб|недостаточно/i.test(alerts))throw new Error(`SoundCloud: ${alerts.slice(0,450)}`);
      await sleep(1600);
    }
    throw new Error('Истекло время ожидания ссылок публикации. Не повторяй пачку, пока не проверишь треки в аккаунте.');
  }
  function findField(root,names,placeholder) {
    return all('input:not([type="radio"]):not([type="checkbox"]):not([type="hidden"]),textarea',root).filter(e=>visible(e)&&
      (names.some(n=>n.test(associatedText(e))) || (placeholder&&placeholder.test(e.placeholder||''))));
  }
  async function chooseRadio(root,pattern,description) {
    const candidates=all('input[type="radio"],[role="radio"]',root).filter(e=>pattern.test(associatedText(e)||label(e)));
    const e=unique(candidates,description);if(!checked(e))e.click();await sleep(150);if(!checked(e))throw new Error(`Не подтверждено: ${description}`);
  }
  async function rating(root,value) {
    const select=all('select',root).find(e=>/content rating|рейтинг|explicit/i.test(associatedText(e)));
    if(select){const option=unique([...select.options].filter(o=>F.normalize(o.textContent)===value),'рейтинг трека');select.value=option.value;select.dispatchEvent(new Event('change',{bubbles:true}));if(select.value!==option.value)throw new Error('Рейтинг не сохранился.');return;}
    const triggers=all('[role="combobox"],button',root).filter(e=>visible(e)&&['Select content rating','Not Explicit','Explicit','Clean Edit'].includes(label(e)));
    const trigger=unique(triggers,'поле Content rating');if(label(trigger)===value)return;
    trigger.click();await sleep(250);
    const choices=all('[role="option"],[role="menuitem"],button',document).filter(e=>visible(e)&&label(e)===value&&e!==trigger);
    unique(choices,'вариант рейтинга').click();await sleep(150);if(label(trigger)!==value)throw new Error('SoundCloud не подтвердил выбранный рейтинг.');
  }
  function targetRow(track) {
    const target=F.trackUrl(track.publishUrl,new URL(track.publishUrl).pathname.split('/')[1]);
    const anchors=all('a[href]').filter(a=>visible(a)&&a.href.split('?')[0].replace(/\/$/,'')===target);
    const titles=anchors.length?anchors:all('a,span,strong').filter(e=>visible(e)&&label(e)===track.title);
    const candidates=[];
    for(const item of titles){let row=item;for(let i=0;i<7&&row&&row!==document.body;i++,row=row.parentElement){
      if(buttons(['Monetize this track','Monetize','Монетизировать'],row).length===1 ||
        (row.matches('tr,li,[role="row"],[class*="trackRow"],[class*="track-row"]')&&/monetizing|under review|submitted|pending|отправлен|проверке/i.test(label(row)))){candidates.push(row);break;}
    }}
    return [...new Set(candidates)];
  }
  function rowStatus(row) {
    const values=all('[role="status"],[class*="status"],[data-testid*="status"],span',row).filter(visible).map(label);
    if(values.some(x=>/^(monetizing|монетизируется)$/i.test(x)))return 'monetizing';
    if(values.some(x=>/^(under review|submitted|pending|pending review|на проверке|отправлен[ао]?)$/i.test(x)))return 'submitted';
    return null;
  }
  async function monetize(job) {
    // These inputs are supplied by the user's saved metadata, never inferred from AI lyrics.
    const metadata=job.tracks.map(t=>F.monetizationMetadata(job,t));
    await verifyJobIdentity(job,true);
    for(let index=0;index<job.tracks.length;index++){
      const track=job.tracks[index],m=metadata[index];await checkConnection();
      let rows=targetRow(track);
      if(rows.length!==1){const searches=all('input[type="search"],input[placeholder]').filter(e=>visible(e)&&/search tracks|search by title|поиск треков/i.test(associatedText(e)+' '+e.placeholder));
        if(searches.length===1){setValue(searches[0],track.title);await sleep(1200);rows=targetRow(track);}}
      const row=unique(rows,`строку «${track.title}» в монетизации`);
      const existing=rowStatus(row);
      if(existing==='monetizing'){await report('progress',`${track.title}: монетизация уже активна.`,[{id:track.id,status:'monetizing',publishUrl:track.publishUrl}]);continue;}
      if(existing==='submitted'){await report('progress',`${track.title}: заявка уже на проверке.`,[{id:track.id,status:'submitted',publishUrl:track.publishUrl}]);continue;}
      unique(buttons(['Monetize this track','Monetize','Монетизировать'],row),'кнопку монетизации выбранного трека').click();
      const modal=await waitFor(()=>{const d=all('[role="dialog"],dialog[open]').filter(visible);return d.length===1?d[0]:null;},15000,'форму монетизации');
      if(!label(modal).includes(track.title))throw new Error('В форме не видно название выбранного трека. Проверь её вручную.');
      const artistFields=findField(modal,[/^main artist$/i,/^основной артист$/i]);
      if(!artistFields.length){for(const tag of all('label,span',modal).filter(e=>label(e)==='Main Artist')){
        const possible=all('input[type="text"],input:not([type])',tag.parentElement).filter(visible);if(possible.length===1)artistFields.push(possible[0]);}}
      setValue(unique([...new Set(artistFields)],'Main Artist'),m.mainArtist);
      setValue(unique(findField(modal,[/full legal name|composer.*name|songwriter.*name|полное.*имя/i],/^Full legal name$/i),'юридическое имя автора'),m.legalName);
      await rating(modal,m.contentRating);
      await chooseRadio(modal,m.songwriterRole==='writer'?/I wrote this song/i:/I represent the writer/i,'отношение к авторам');
      const isrcGroups=all('fieldset,[role="group"]',modal).filter(e=>/ISRC/i.test(label(e)));
      const isrcScope=isrcGroups.length===1?isrcGroups[0]:modal;
      await chooseRadio(isrcScope,m.isrc===null?/^No$|^Нет$/i:/^Yes$|^Да$/i,'наличие ISRC');
      if(m.isrc!==null)setValue(unique(findField(modal,[/^ISRC$/i],/ISRC/i),'код ISRC'),m.isrc);
      const rights=unique(all('input[type="checkbox"],[role="checkbox"]',modal).filter(e=>/I have the rights to monetize this track/i.test(associatedText(e)||label(e))),'подтверждение прав');
      if(!checked(rights))rights.click();await sleep(150);if(!checked(rights))throw new Error('Подтверждение прав не применилось.');
      const submit=unique(buttons(['Submit','Отправить'],modal),'кнопку отправки заявки');
      await checkConnection();await verifyJobIdentity(job,true);
      await report('progress',`Отправляю заявку: ${track.title}.`,[{id:track.id,status:'submitting',publishUrl:track.publishUrl}]);
      sideEffect=true;submit.click();
      await waitFor(()=>!visible(modal),20000,'закрытие формы после отправки');
      await waitFor(()=>targetRow(track).some(r=>rowStatus(r)==='submitted'),20000,'подтверждение статуса заявки');
      await report('progress',`${track.title}: заявка отправлена на проверку.`,[{id:track.id,status:'submitted',publishUrl:track.publishUrl}]);
      await sleep(1500);
    }
    await report('complete','Заявки обработаны. «Отправлено» означает проверку SoundCloud, не активную монетизацию.');
  }
  async function inspect(job,hadSideEffect) {
    sideEffect=hadSideEffect;
    if(!hadSideEffect){
      if(job.type==='publish')return publish(job);
      return monetize(job);
    }
    if(job.type==='publish'&&sideEffect&&location.pathname==='/upload'&&/upload complete|successfully uploaded|go to your tracks?|успешно загруж|загрузка завершена/i.test(document.body.innerText)){
      const found=F.verifiedResults(job,publishedLinks(job));if(found.length===job.tracks.length){await report('complete','Ссылки опубликованных треков проверены после перехода страницы.',found);return;}}
    throw new Error('Страница обновилась во время задания. Автоматический повтор выключен: проверь текущий результат в SoundCloud.');
  }
  async function start() {
    if(running)return;running=true;
    let job;
    try {
      const response=await send('content.ready',{contentRevision:CONTENT_REVISION});
      heartbeat=setInterval(()=>send('content.ping').catch(()=>{}),10000);
      if(response.verify){const handle=await verifyIdentity(response.verify.handle);await send('content.verified',{handle});clearInterval(heartbeat);return;}
      job=response.job||response.inspect;if(!job){clearInterval(heartbeat);return;}
      if(response.inspect)await inspect(job,response.sideEffect);
      else if(job.type==='publish')await publish(job);else await monetize(job);
    }catch(e){
      clearInterval(heartbeat);
      if(!finished){
        const uncertain=sideEffect?(job?.tracks||[]).filter(t=>!results.some(r=>r.id===t.id&&F.terminal.has(r.status))).map(t=>({id:t.id,status:'uncertain',message:'Проверь результат во вкладке перед повтором.'})):[];
        await report('blocked',e.message,uncertain).catch(()=>{});
      }
    }
  }
  // Unrelated SoundCloud tabs do nothing; only the worker-owned tab receives a job.
  start();
})();
