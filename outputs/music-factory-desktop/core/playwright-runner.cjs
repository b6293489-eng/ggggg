'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {chromium}=require('playwright-core');

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const normalize=value=>String(value||'').replace(/\s+/g,' ').trim().toLowerCase();
class AutomationError extends Error { constructor(message,{sideEffect=false}={}){super(message);this.sideEffect=sideEffect;} }

class SoundCloudPlaywright {
  static defaultChromeExecutable(){
    const os=require('node:os');
    const candidates=process.platform==='darwin'
      ?['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',path.join(os.homedir(),'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')]
      :[path.join(process.env.PROGRAMFILES||'C:\\Program Files','Google/Chrome/Application/chrome.exe'),path.join(process.env['PROGRAMFILES(X86)']||'C:\\Program Files (x86)','Google/Chrome/Application/chrome.exe'),path.join(process.env.LOCALAPPDATA||os.homedir(),'Google/Chrome/Application/chrome.exe')];
    return candidates.find(p=>fs.existsSync(p))||null;
  }
  constructor({dataDir,factory,log=()=>{},onEvent=()=>{},browserType=chromium,chromeExecutable=null,spawnProcess=spawn}){
    this.dataDir=dataDir;this.factory=factory;this.log=log;this.onEvent=onEvent;this.browserType=browserType;this.chromeExecutable=chromeExecutable||SoundCloudPlaywright.defaultChromeExecutable();this.spawnProcess=spawnProcess;
    this.contexts=new Map();this.loginProcesses=new Map();this.running=false;this.closed=false;this.current=null;
    this.root=path.join(dataDir,'Playwright Profiles');fs.mkdirSync(this.root,{recursive:true});
  }
  account(accountId){return this.factory.getState().accounts.find(account=>account.id===accountId);}
  profileDir(accountId){if(!/^[a-z0-9_-]+$/i.test(accountId))throw new Error('Некорректный аккаунт.');return path.join(this.root,accountId);}
  verificationFile(accountId){return path.join(this.profileDir(accountId),'.music-factory-soundcloud.json');}
  profileExists(accountId){const dir=this.profileDir(accountId);return fs.existsSync(dir)&&fs.readdirSync(dir).length>0;}
  profileVerified(accountId){
    try{const value=JSON.parse(fs.readFileSync(this.verificationFile(accountId),'utf8'));return Boolean(value?.verifiedAt&&value?.uploaderFrame==='/n/upload');}
    catch{return false;}
  }
  markVerified(accountId,frameUrl){
    fs.writeFileSync(this.verificationFile(accountId),JSON.stringify({verifiedAt:new Date().toISOString(),uploaderFrame:'/n/upload',frameUrl},null,2));
  }
  status(){const accounts=this.factory.getState().accounts;return {mode:'playwright',running:this.running,accountId:this.current?.accountId||null,profiles:Object.fromEntries(accounts.map(a=>[a.id,this.profileExists(a.id)])),verified:Object.fromEntries(accounts.map(a=>[a.id,this.profileVerified(a.id)]))};}
  async context(accountId,{headless=false}={}){
    const existing=this.contexts.get(accountId);if(existing)return existing;
    const dir=this.profileDir(accountId);fs.mkdirSync(dir,{recursive:true});
    const defaultUA=process.platform==='darwin'
      ?'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36'
      :'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';
    let context;
    try{
      context=await this.browserType.launchPersistentContext(dir,{
        channel:'chrome',
        headless,
        userAgent:defaultUA,
        viewport:headless?{width:1440,height:1000}:null,
        acceptDownloads:false,
        ignoreDefaultArgs:['--use-mock-keychain','--password-store=basic'],
        args:[
          '--disable-session-crashed-bubble',
          '--disable-features=Translate',
          '--disable-blink-features=AutomationControlled'
        ]
      });
    }catch(error){
      throw new AutomationError(`Не удалось открыть отдельный Chrome Factory для ${this.account(accountId)?.label||accountId}: ${error.message}. Закрой старое окно Chrome Factory и повтори.\nПрофиль: ${dir}`);
    }
    context.setDefaultTimeout(30000);context.setDefaultNavigationTimeout(60000);
    context.on('close',()=>{if(this.contexts.get(accountId)===context)this.contexts.delete(accountId);this.onEvent();});
    this.contexts.set(accountId,context);this.onEvent();return context;
  }
  async page(accountId,url='https://soundcloud.com/',options={}){
    const context=await this.context(accountId,options);let page=context.pages().find(item=>!item.isClosed())||await context.newPage();
    if(!options.headless)await page.bringToFront();if(url&&page.url()!==url)await page.goto(url,{waitUntil:'domcontentloaded'});return page;
  }
  async openLogin(accountId){
    const account=this.account(accountId);if(!account)throw new Error('Неизвестный аккаунт.');
    const dir=this.profileDir(accountId);fs.mkdirSync(dir,{recursive:true});
    if(!this.chromeExecutable){
      throw new AutomationError(`Google Chrome не найден на компьютере. Установите Google Chrome для чистого ручного входа в профиль ${account.label}.`);
    }
    // Fully close any lingering Playwright session so clean Chrome has exclusive access to the profile
    await this.close(accountId).catch(()=>{});
    await sleep(300);

    const current=this.loginProcesses.get(accountId);
    if(current&&current.exitCode===null)return {ok:true,accountId,profileDir:dir,alreadyOpen:true,mode:'manual'};

    // Mode 1: Pure clean Chrome spawn without ANY debugging or automation flags.
    // No --remote-debugging-port, no --remote-allow-origins, no --enable-automation, no mock keychain.
    const args=[
      `--user-data-dir=${dir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--new-window',
      'https://soundcloud.com/you'
    ];
    let child;
    try{child=this.spawnProcess(this.chromeExecutable,args,{detached:true,stdio:'ignore',windowsHide:false});}
    catch(error){throw new AutomationError(`Не удалось открыть чистый Chrome для входа: ${error.message}\nПрофиль: ${dir}`);}
    child.on?.('error',error=>{this.log(`Chrome login ${accountId}: ${error.message}`);this.loginProcesses.delete(accountId);this.onEvent();});
    child.on?.('exit',()=>{if(this.loginProcesses.get(accountId)===child)this.loginProcesses.delete(accountId);this.onEvent();});
    child.unref?.();this.loginProcesses.set(accountId,child);this.onEvent();
    this.factory.event(`Открыт обычный чистый Chrome для ${account.label} (без автоматизации и debug-портов). Войди через Google в @${account.handle}, полностью закрой Chrome и нажми «Проверить вход».`);
    return {ok:true,accountId,profileDir:dir,mode:'manual'};
  }
  async verifyLogin(accountId){
    const account=this.account(accountId);if(!account)throw new Error('Неизвестный аккаунт.');
    const dir=this.profileDir(accountId);
    const candidateCookiePaths=[
      path.join(dir,'Default','Cookies'),
      path.join(dir,'Default','Network','Cookies')
    ];
    const cookiesPath=candidateCookiePaths.find(p=>fs.existsSync(p))||candidateCookiePaths[0];

    // 1. Give Chrome process time to exit and flush cookies to disk
    const loginProcess=this.loginProcesses.get(accountId);
    if(loginProcess){
      if(loginProcess.exitCode===null){
        for(let i=0;i<6;i++){
          await sleep(500);
          if(loginProcess.exitCode!==null||!this.loginProcesses.has(accountId))break;
        }
      }
      if(loginProcess.exitCode===null){
        try{loginProcess.kill('SIGTERM');}catch{}
        for(let i=0;i<6;i++){
          await sleep(500);
          if(loginProcess.exitCode!==null||!this.loginProcesses.has(accountId))break;
        }
        if(loginProcess.exitCode===null){
          throw new AutomationError(
            `Окно браузера для ${account.label} ещё не закрылось (PID ${loginProcess.pid}).\n` +
            `Профиль: ${dir}\n\n` +
            `Пожалуйста, полностью закрой отдельное окно Chrome Factory (на Mac: Cmd+Q в окне Chrome) и повтори проверку.`
          );
        }
      }
      this.loginProcesses.delete(accountId);
    }

    // Give OS and SQLite persistent store time to flush buffers and release locks
    await sleep(600);

    const cookiesFileExists=fs.existsSync(cookiesPath);
    let cookiesFileSize=0;
    if(cookiesFileExists){
      try{cookiesFileSize=fs.statSync(cookiesPath).size;}catch{}
    }

    let scCookies=[];
    let oauthCookie=null;
    let currentUrl='';
    let observedHandle=null;

    try{
      const context=await this.context(accountId,{headless:true});
      if(typeof context.cookies==='function'){
        scCookies=await context.cookies(['https://soundcloud.com','https://artists.soundcloud.com']).catch(()=>[]);
        oauthCookie=scCookies.find(c=>c.name==='oauth_token');
      }

      const page=context.pages().find(item=>!item.isClosed())||await context.newPage();

      // Check session via /you redirect if cookies method is available
      if(typeof context.cookies==='function'){
        await page.goto('https://soundcloud.com/you',{waitUntil:'domcontentloaded'});
        await sleep(2500);
        currentUrl=page.url();

        if(/\/signin([/?#]|$)/i.test(currentUrl)||!oauthCookie){
          throw new AutomationError(
            `В отдельном браузере Factory нет входа в SoundCloud для @${account.handle}.\n\n` +
            `Детали проверки профиля:\n` +
            `• Путь к профилю: ${dir}\n` +
            `• Файл Cookies: ${cookiesFileExists ? `найден (${cookiesFileSize} байт)` : 'файл отсутствует'}\n` +
            `• Найдено cookies SoundCloud: ${scCookies.length} (токен oauth_token: ${oauthCookie ? 'найден' : 'ОТСУТСТВУЕТ'})\n` +
            `• Текущий URL: ${currentUrl||'не определён'}\n\n` +
            `Как исправить: Нажми «Открыть браузер Factory», выполни вход в аккаунт @${account.handle}, закрой Chrome и снова нажми «Проверить вход».`
          );
        }

        try{
          const urlObj=new URL(currentUrl);
          const parts=urlObj.pathname.split('/').filter(Boolean);
          if(parts.length>=1&&!['you','signin','discover','stream','upload','pages'].includes(parts[0].toLowerCase())){
            observedHandle=parts[0];
          }
        }catch{}

        if(observedHandle&&account.handle&&observedHandle.toLowerCase()!==account.handle.toLowerCase()){
          throw new AutomationError(
            `В браузере выполнен вход под аккаунтом @${observedHandle}, а для этой карточки требуется @${account.handle}!\n\n` +
            `Детали проверки:\n` +
            `• Путь к профилю: ${dir}\n` +
            `• Обнаружен аккаунт: @${observedHandle}\n` +
            `• Ожидался аккаунт: @${account.handle}\n\n` +
            `Как исправить: Открой браузер Factory, выйди и выполни вход в правильный аккаунт @${account.handle}.`
          );
        }
      }

      await page.goto('https://soundcloud.com/upload',{waitUntil:'domcontentloaded'});
      await this.guard(page,false,dir,account);
      const frame=await this.uploadFrame(page,dir,account);
      await this.guard(frame,false,dir,account);
      const fileInput=frame.locator('input[type="file"]').first();
      await fileInput.waitFor({state:'attached',timeout:60000});

      this.markVerified(accountId,frame.url());
      this.factory.event(`Playwright проверен для ${account.label}: вход сохранён (@${observedHandle||account.handle}), внутренний загрузчик /n/upload найден. Файлы не передавались.`);
      await this.close(accountId);
      this.onEvent();
      return {ok:true,accountId,verified:true,uploaderFrame:'/n/upload',observedHandle:observedHandle||account.handle};
    }catch(error){
      await this.close(accountId).catch(()=>{});
      this.onEvent();
      if(error instanceof AutomationError)throw error;
      throw new AutomationError(
        `Ошибка при проверке входа в SoundCloud для ${account.label} (@${account.handle}): ${error.message}\n\n` +
        `Детали проверки:\n` +
        `• Путь к профилю: ${dir}\n` +
        `• Файл Cookies: ${cookiesFileExists ? `найден (${cookiesFileSize} байт)` : 'отсутствует'}\n` +
        `• Cookies SoundCloud: ${scCookies.length} (oauth_token: ${oauthCookie ? 'найден' : 'отсутствует'})\n` +
        `• Итоговый URL: ${currentUrl||'не загружен'}`
      );
    }
  }
  async close(accountId){const context=this.contexts.get(accountId);if(context)await context.close().catch(()=>{});this.contexts.delete(accountId);return {ok:true};}
  async closeAll(){this.closed=true;for(const context of this.contexts.values())await context.close().catch(()=>{});this.contexts.clear();}
  async bodyText(scope){return String(await scope.locator('body').innerText({timeout:5000}).catch(()=>''));}
  async guard(scope,sideEffect=false,dir='',account=null){
    const text=normalize(await this.bodyText(scope));
    const details=dir?`\nПрофиль: ${dir}${account?` (@${account.handle})`:''}`:'';
    if(/captcha|verify you are human|провер(ьте|ка),? что вы человек|robot check/.test(text))throw new AutomationError(`SoundCloud показал CAPTCHA. Пройди её вручную в открытом браузере Factory, затем повтори.${details}`,{sideEffect});
    if(/payment failed|update your payment|pay now|upgrade.*artist|purchase|ошибка оплаты/.test(text))throw new AutomationError(`SoundCloud требует решить вопрос оплаты или подписки. Factory ничего не покупает и остановилась.${details}`,{sideEffect});
    const url=scope.url?scope.url():'';
    if(/\/signin([/?#]|$)/i.test(url)||((/sign in|log in|войти/.test(text)&&!/log out|выйти/.test(text))&&!/\/n\/upload/.test(url)))throw new AutomationError(`В отдельном браузере Factory нет входа в SoundCloud. Войди в нужный аккаунт и повтори.${details}`,{sideEffect});
  }
  report(job,status,message,tracks=[],safeToRetry=false){
    this.log(`Playwright ${job.accountId}/${job.id}: ${message}`);
    return this.factory.reportJob(job.accountId,job.id,{reportId:crypto.randomUUID(),status,message,tracks,safeToRetry});
  }
  async uploadFrame(page,dir='',account=null){
    const deadline=Date.now()+90000;
    while(Date.now()<deadline){
      const frame=page.frames().find(item=>/\/n\/upload(?:[/?#]|$)/.test(item.url()));if(frame)return frame;
      await this.guard(page,false,dir,account);await sleep(500);
    }
    const details=dir?`\nПрофиль: ${dir}${account?` (@${account.handle})`:''}`:'';
    throw new AutomationError(`SoundCloud не открыл встроенный загрузчик /n/upload. Обнови страницу в браузере Factory и проверь вход.${details}`);
  }
  async visible(locator,timeout=30000){await locator.first().waitFor({state:'visible',timeout});return locator.first();}
  async waitUploadButtonReady(frame,upload,job,uploading,timeout=25*60*1000){
    const deadline=Date.now()+timeout;
    let lastProgressReport=0;
    while(Date.now()<deadline){
      await this.guard(frame,true);
      const isEnabled=await upload.isEnabled().catch(()=>false);
      const isAriaDisabled=await upload.getAttribute('aria-disabled').catch(()=>null)==='true';
      const hasDisabledClass=await upload.evaluate(el=>el.classList.contains('Mui-disabled')).catch(()=>false);
      if(isEnabled&&!isAriaDisabled&&!hasDisabledClass){
        const albumInput=frame.locator('input#title, input[name="title"]:not([name*="trackList"])').first();
        if(await albumInput.count()){
          const currentTitle=await albumInput.inputValue().catch(()=>'');
          if(!currentTitle.trim())await albumInput.fill(job.albumTitle);
        }
        return true;
      }

      const now=Date.now();
      if(now-lastProgressReport>10000){
        lastProgressReport=now;
        const progressInfo=await frame.evaluate(()=>{
          const progressBars=document.querySelectorAll('[role="progressbar"], .MuiCircularProgress-root, .MuiLinearProgress-root');
          const percentEls=Array.from(document.querySelectorAll('*')).filter(el=>/^\d{1,3}%$/.test((el.innerText||'').trim())).map(el=>el.innerText.trim());
          return {count:progressBars.length,samplePercents:percentEls.slice(0,3)};
        }).catch(()=>({count:0,samplePercents:[]}));
        const progressMsg=progressInfo.count>0
          ?`SoundCloud обрабатывает файлы (активно индикаторов: ${progressInfo.count}${progressInfo.samplePercents.length?`, ${progressInfo.samplePercents.join(', ')}`:''}). Ожидаю разблокировки кнопки Upload...`
          :'SoundCloud завершает проверку треков. Ожидаю активации кнопки Upload...';
        try{await this.report(job,'progress',`Альбом «${job.albumTitle}»: ${progressMsg}`,uploading);}catch{}
      }
      await sleep(1500);
    }
    throw new AutomationError(
      `Кнопка Upload осталась заблокированной после ${Math.round(timeout/60000)} минут ожидания обработки файлов в SoundCloud.\n`+
      `Проверь форму публикации альбома «${job.albumTitle}» вручную.`,
      {sideEffect:true}
    );
  }
  async waitUploadComplete(frame,page){
    const deadline=Date.now()+25*60*1000;
    while(Date.now()<deadline){
      await this.guard(frame,true);const text=normalize(await this.bodyText(frame));
      if(/successfully uploaded|saved to soundcloud|tracks? are now on soundcloud|upload complete|ready to share/.test(text))return;
      await sleep(2000);
    }
    throw new AutomationError('SoundCloud не подтвердил завершение загрузки. Проверь результат во вкладке; автоматический повтор выключен.',{sideEffect:true});
  }
  async collectPublished(page,job){
    const account=this.account(job.accountId),found=new Map(),wanted=new Map(job.tracks.map(t=>[normalize(t.title),t]));
    for(let attempt=0;attempt<8&&found.size<wanted.size;attempt++){
      if(attempt===0)await page.goto(`https://soundcloud.com/${account.handle}/tracks`,{waitUntil:'domcontentloaded'});
      await sleep(attempt?2500:5000);
      const links=await page.locator(`a[href^="/${account.handle}/"],a[href^="https://soundcloud.com/${account.handle}/"]`).evaluateAll(nodes=>nodes.map(node=>({href:node.href,text:(node.innerText||node.textContent||node.getAttribute('aria-label')||node.getAttribute('title')||'').trim()}))).catch(()=>[]);
      for(const link of links){
        let url;try{url=new URL(link.href,'https://soundcloud.com');}catch{continue;}const parts=url.pathname.split('/').filter(Boolean);
        if(parts.length!==2||parts[0].toLowerCase()!==account.handle.toLowerCase())continue;
        const title=wanted.get(normalize(link.text));if(title&&!found.has(title.id))found.set(title.id,{id:title.id,status:'published',publishUrl:`https://soundcloud.com/${parts.join('/')}`});
      }
      await page.mouse.wheel(0,1800).catch(()=>{});
    }
    return [...found.values()];
  }
  async publish(page,job,state){
    await this.report(job,'progress','Playwright открыл сохранённый браузерный профиль. Перехожу к загрузчику SoundCloud.');
    await page.goto('https://soundcloud.com/upload',{waitUntil:'domcontentloaded'});const frame=await this.uploadFrame(page);await this.guard(frame,false);
    const fileInput=frame.locator('input[type="file"]').first();await fileInput.waitFor({state:'attached',timeout:60000});
    const multiple=await fileInput.getAttribute('multiple');if(job.tracks.length>1&&multiple===null)throw new AutomationError('SoundCloud открыл форму одного трека вместо пакетной загрузки.');
    const uploading=job.tracks.map(track=>({id:track.id,status:'uploading'}));
    await this.report(job,'progress',`Передаю ${job.tracks.length} файлов в редактор альбома через Playwright.`,uploading);state.sideEffect=true;state.tracks=uploading;
    await fileInput.setInputFiles(job.tracks.map(track=>this.factory.audioPath(track.id)));
    await this.guard(frame,true);
    let album=frame.locator('input#title, input[name="title"]:not([name*="trackList"])').first();
    if(!await album.count())album=frame.getByLabel(/album title/i).first();
    await album.waitFor({state:'visible',timeout:120000});await album.fill(job.albumTitle);

    // Fill human-readable song titles for all tracks from job.tracks
    for(let i=0;i<job.tracks.length;i++){
      const track=job.tracks[i];
      let trackInput=frame.locator(`input[name="trackList.${i}.title"], input#trackList\\.${i}\\.title`).first();
      if(!await trackInput.count()){
        trackInput=frame.locator(`input[value*="${track.id}"]`).first();
      }
      if(await trackInput.count()){
        await trackInput.fill(track.title);
      }
    }

    let publicRadio=frame.getByRole('radio',{name:/^public$/i}).first();
    if(!await publicRadio.count())publicRadio=frame.locator('input[type="radio"][value="public" i]').first();
    await publicRadio.check({timeout:30000});
    if(job.amplify!==false){
      const confirmation=frame.getByText(/analyze your tracks for recommendation/i).first();
      if(!await confirmation.isVisible().catch(()=>false)){
        const amplify=await this.visible(frame.getByRole('button',{name:/amplify tracks/i}),120000);await amplify.click();
        await confirmation.waitFor({state:'visible',timeout:30000}).catch(async()=>{await this.guard(frame,true);throw new AutomationError('Amplify нажат, но подтверждение не появилось. Финальная Upload не нажата.',{sideEffect:true});});
      }
    }
    await this.guard(frame,true);
    const upload=await this.visible(frame.getByRole('button',{name:/^upload$/i}),15*60*1000);
    const matching=await frame.getByRole('button',{name:/^upload$/i}).count();if(matching!==1)throw new AutomationError('В форме несколько кнопок Upload. Ничего не нажато.',{sideEffect:true});
    await this.report(job,'progress',`Альбом «${job.albumTitle}»: файлы переданы. Ожидаю завершения обработки и разблокировки кнопки Upload...`,uploading);
    await this.waitUploadButtonReady(frame,upload,job,uploading);
    await this.report(job,'progress',`Альбом «${job.albumTitle}»: Public${job.amplify!==false?', Amplify включён':''}. Все файлы обработаны, нажимаю финальную Upload.`,uploading);
    await upload.click({timeout:60000});await this.waitUploadComplete(frame,page);
    const published=await this.collectPublished(page,job);state.tracks=published;
    if(published.length!==job.tracks.length){
      const missing=job.tracks.filter(t=>!published.some(item=>item.id===t.id)).map(t=>({id:t.id,status:'uncertain',message:'Загрузка завершилась, но ссылка не найдена автоматически.'}));
      await this.report(job,'uncertain',`SoundCloud завершил загрузку, но найдено ссылок ${published.length}/${job.tracks.length}. Проверь альбом вручную.`,[...published,...missing],false);return;
    }
    await this.report(job,'complete',`Опубликовано: ${published.length}. Все ссылки проверены в профиле.`,published,false);
  }
  async monetize(page,job,state){
    const completed=[];await page.goto('https://artists.soundcloud.com/monetization/soundcloud',{waitUntil:'domcontentloaded'});await this.guard(page,false);
    for(const track of job.tracks){
      const title=page.getByText(track.title,{exact:true}).first();await title.waitFor({state:'visible',timeout:60000});
      let row=title.locator('xpath=ancestor::*[.//button][1]');const text=normalize(await row.innerText().catch(()=>''));
      if(/cancel monetization|monetizing|under review|submitted/.test(text)){completed.push({id:track.id,status:'submitted',publishUrl:track.publishUrl});continue;}
      const button=row.getByRole('button',{name:/monetize( this track)?/i}).first();await button.click();
      const dialog=page.getByRole('dialog').first();await dialog.waitFor({state:'visible',timeout:30000});await this.guard(dialog,false);
      const legal=dialog.locator('input[placeholder*="legal" i],input[name*="contributor" i]').first();if(await legal.count())await legal.fill(track.legalName);
      const rating=dialog.getByText(new RegExp(`^${track.contentRating}$`,'i')).first();if(!await rating.isVisible().catch(()=>false)){const combo=dialog.getByRole('combobox').first();if(await combo.count()){await combo.click();await page.getByText(new RegExp(`^${track.contentRating}$`,'i')).last().click();}}
      const rights=dialog.getByText(/I have the rights to monetize this track/i).first();if(await rights.count())await rights.click();
      const submit=await this.visible(dialog.getByRole('button',{name:/^submit$/i}),30000);
      const update={id:track.id,status:'submitting',publishUrl:track.publishUrl};await this.report(job,'progress',`Отправляю заявку: ${track.title}.`,[...completed,update]);state.sideEffect=true;state.tracks=[...completed,update];
      await submit.click();await dialog.waitFor({state:'hidden',timeout:30000});completed.push({id:track.id,status:'submitted',publishUrl:track.publishUrl});state.tracks=[...completed];
    }
    await this.report(job,'complete','Заявки отправлены на проверку SoundCloud.',completed,false);
  }
  async runQueued(accountId){
    if(this.running||this.closed)return false;const job=this.factory.claimJob(accountId);if(!job)return false;
    this.running=true;const state={sideEffect:false,tracks:[]};this.current={accountId,jobId:job.id};this.onEvent();
    const heartbeat=setInterval(()=>{if(this.current?.jobId===job.id)Promise.resolve().then(()=>this.report(job,'progress',job.type==='publish'?'Playwright ожидает завершения загрузки SoundCloud.':'Playwright обрабатывает заявки.',state.tracks)).catch(()=>{});},30000);heartbeat.unref?.();
    try{
      if(!this.profileVerified(accountId))throw new AutomationError('Сначала открой аккаунт в браузере Factory и нажми «Проверить вход». Публикация не начиналась.');
      const page=await this.page(accountId);if(job.type==='publish')await this.publish(page,job,state);else await this.monetize(page,job,state);
    }
    catch(error){
      const sideEffect=state.sideEffect||error.sideEffect;
      const tracks=sideEffect?job.tracks.map(track=>state.tracks.find(item=>item.id===track.id)||({id:track.id,status:'uncertain',message:'Проверь результат в SoundCloud.'})):[];
      try{await this.report(job,sideEffect?'uncertain':'blocked',error.message,tracks,!sideEffect);}
      catch(reportError){this.log(`Playwright report failed: ${reportError.message}`);}
    }finally{clearInterval(heartbeat);await this.close(accountId);this.running=false;this.current=null;this.onEvent();}
    return true;
  }
}

module.exports={SoundCloudPlaywright,AutomationError,normalize};
