'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.flac', '.aif', '.aiff', '.ogg', '.m4a']);
const LIVE_JOBS = new Set(['queued', 'running']);
const FINISHED_TRACKS = new Set(['published', 'submitted', 'monetizing', 'rejected']);
const clone = value => JSON.parse(JSON.stringify(value));
const uid = prefix => `${prefix}_${crypto.randomUUID()}`;
const now = () => new Date().toISOString();

function text(value, max = 500) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function assert(ok, message) { if (!ok) throw new Error(message); }
function albumName(value) {
  assert(typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 100 && !/[\x00-\x1f]/.test(value), 'Название альбома должно содержать от 1 до 100 символов без переносов строк.');
  return value.trim();
}
function albumPart(title, number) {
  const suffix = ` · Part ${number}`;
  const base = title.slice(0, 100 - suffix.length).replace(/[\uD800-\uDBFF]$/, '').trimEnd();
  return `${base}${suffix}`;
}
function writeJSON(file, value) {
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2));
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(tmp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}
function audioInfo(file) {
  assert(typeof file === 'string' && path.isAbsolute(file), 'Нужен абсолютный путь к аудиофайлу.');
  const real = fs.realpathSync(file);
  assert(AUDIO_EXTENSIONS.has(path.extname(real).toLowerCase()), 'Поддерживаются WAV, MP3, FLAC, AIFF, OGG и M4A.');
  const stat = fs.statSync(real);
  assert(stat.isFile() && stat.size > 44, 'Аудиофайл пуст или недоступен.');
  const fd = fs.openSync(real, 'r');
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.alloc(1024 * 1024);
  let length, duration = null;
  try {
    while ((length = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, length));
    if (path.extname(real).toLowerCase() === '.wav') {
      const header = Buffer.alloc(12);
      fs.readSync(fd, header, 0, header.length, 0);
      assert(header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WAVE', 'Некорректный WAV: нет заголовка RIFF/WAVE.');
      const riffEnd = header.readUInt32LE(4) + 8;
      assert(riffEnd <= stat.size && riffEnd >= 44, 'WAV усечён: размер RIFF не соответствует файлу.');
      let byteRate = 0, dataBytes = 0;
      const chunkHeader = Buffer.alloc(8), format = Buffer.alloc(16);
      for (let i = 12; i + 8 <= riffEnd;) {
        fs.readSync(fd, chunkHeader, 0, 8, i);
        const tag = chunkHeader.toString('ascii', 0, 4), size = chunkHeader.readUInt32LE(4);
        assert(i + 8 + size <= riffEnd && i + 8 + size <= stat.size, 'WAV усечён: аудиоданные или служебный блок выходят за конец файла.');
        if (tag === 'fmt ') {
          assert(size >= 16, 'Некорректный WAV: блок формата слишком короткий.');
          fs.readSync(fd, format, 0, 16, i + 8);
          byteRate = format.readUInt32LE(8);
          assert(format.readUInt16LE(2) > 0 && format.readUInt32LE(4) > 0 && byteRate > 0 && format.readUInt16LE(12) > 0, 'Некорректный WAV: частота, каналы или скорость аудио равны нулю.');
        }
        if (tag === 'data') dataBytes += size;
        i += 8 + size + (size % 2);
      }
      assert(byteRate > 0 && dataBytes > 0, 'Некорректный WAV: нет формата или аудиоданных.');
      duration = Math.round(dataBytes / byteRate * 100) / 100;
    }
  } finally { fs.closeSync(fd); }
  return { path: real, checksum: hash.digest('hex'), bytes: stat.size, duration, modifiedAt: stat.mtimeMs };
}
function localAceUrl(value) {
  const url = new URL(value);
  assert(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !url.username && !url.password, 'ACE-Step должен работать локально: http://127.0.0.1:7860.');
  assert(!url.search && !url.hash && url.pathname === '/', 'Укажите адрес ACE-Step без пути.');
  return url.origin;
}
function acePythonPath(dir, platform = process.platform) {
  return path.join(dir, '.venv', platform === 'win32' ? 'Scripts' : 'bin', platform === 'win32' ? 'python.exe' : 'python');
}
function inspectAceInstallation(dir, platform = process.platform) {
  const folder = typeof dir === 'string' && path.isAbsolute(dir) ? path.resolve(dir) : '';
  const pipeline = folder ? path.join(folder, 'acestep', 'acestep_v15_pipeline.py') : '';
  const python = folder ? acePythonPath(folder, platform) : '';
  return { path: folder, pipeline, python, hasPipeline: Boolean(pipeline && fs.existsSync(pipeline)), hasPython: Boolean(python && fs.existsSync(python)), valid: Boolean(pipeline && python && fs.existsSync(pipeline) && fs.existsSync(python)) };
}
function defaultAceSearchRoots(homeDir = os.homedir(), environment = process.env) {
  return [
    path.join(homeDir, 'Documents', 'Codex'),
    path.join(homeDir, 'Documents'),
    path.join(homeDir, 'Downloads'),
    path.join(homeDir, 'Desktop'),
    homeDir,
    environment.LOCALAPPDATA && path.join(environment.LOCALAPPDATA, 'Programs'),
    environment.PROGRAMFILES,
    environment['PROGRAMFILES(X86)'],
  ].filter(Boolean);
}
function discoverAceInstallations(options = {}) {
  const platform = options.platform || process.platform;
  const roots = Array.isArray(options.roots) ? options.roots : defaultAceSearchRoots(options.homeDir, options.environment);
  const names = ['ACE-Step-1.5', 'ACE-Step', 'ACE-Step-1.5-main', 'ACE-Step-main'];
  const candidates = [];
  for (const root of roots) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) continue;
    candidates.push(root, ...names.map(name => path.join(root, name)));
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true }).slice(0, 1000)) {
        if (entry.isDirectory() && /^ace[-_ ]?step/i.test(entry.name)) candidates.push(path.join(root, entry.name));
      }
    } catch {}
  }
  const found = [], seen = new Set();
  for (const candidate of candidates) {
    let real;
    try { real = fs.realpathSync(candidate); } catch { continue; }
    const key = platform === 'win32' ? real.toLowerCase() : real;
    if (seen.has(key) || !inspectAceInstallation(real, platform).valid) continue;
    seen.add(key); found.push(real);
  }
  return found;
}
function permalink(value, account) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Нужна ссылка на опубликованный трек SoundCloud.'); }
  const parts = url.pathname.split('/').filter(Boolean);
  assert(url.protocol === 'https:' && ['soundcloud.com', 'www.soundcloud.com'].includes(url.hostname) && !url.username && !url.password && parts.length === 2 && parts[0].toLowerCase() === account.handle.toLowerCase() && !['tracks', 'sets', 'albums', 'likes', 'popular-tracks'].includes(parts[1]), 'Ссылка должна вести на трек выбранного SoundCloud-аккаунта.');
  return `https://soundcloud.com/${parts.join('/')}`;
}

class Factory {
  constructor(rootData, options = {}) {
    assert(path.isAbsolute(rootData), 'Папка данных должна иметь абсолютный путь.');
    this.rootData = rootData; this.options = options; this.closed = false;
    this.platform = options.platform || process.platform;
    this.stateFile = path.join(rootData, 'factory-state.json');
    this.worker = null; this.aceProcess = null; this.pumping = false;
    fs.mkdirSync(rootData, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(rootData, 'audio'), { recursive: true });
    fs.mkdirSync(path.join(rootData, 'jobs'), { recursive: true });
    fs.mkdirSync(path.join(rootData, 'logs'), { recursive: true });
    if (fs.existsSync(this.stateFile)) {
      this.state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      assert(this.state.version === 1 && Array.isArray(this.state.tracks) && Array.isArray(this.state.jobs), 'Неизвестный формат данных Factory. Существующие данные сохранены.');
      this.recover();
    } else {
      const defaultAce = path.join(options.homeDir || os.homedir(), 'Documents', 'Codex', 'ACE-Step-1.5');
      this.state = {
        version: 1, paused: false,
        settings: { acePath: inspectAceInstallation(defaultAce, this.platform).valid ? defaultAce : '', aceUrl: 'http://127.0.0.1:7860', hardware: this.platform === 'darwin' ? 'mac' : 'rtx4060', memoryMode: 'restart', memoryPolicyVersion: 1, artistName: '' },
        ace: { online: false, status: 'unknown', owned: false },
        accounts: [
          { id: 'bos', label: 'Бос', handle: 'bos-423483424', chromeProfile: 'Profile 7' },
          { id: 'gleb', label: 'Gleb fps', handle: 'nn1v-680019554', chromeProfile: 'Default' },
          { id: 'rivi', label: 'Rivi', handle: 'rivi-135338423', chromeProfile: 'Profile 4' },
        ].map(account => ({ ...account, connected: false, lastSeen: null, artistName: account.label, legalName: account.id === 'rivi' ? 'Hlib Okhai' : '', mainArtist: account.label, songwriterRole: 'writer', rightsConfirmed: false, contentRating: 'Not Explicit' })),
        tracks: [], jobs: [], events: [],
      };
      this.importSeed(options.seedManifest);
      this.save();
    }
    this.autoConfigureAce();
    this.timer = setInterval(() => { this.checkLeases(); this.checkAce().catch(() => {}); this.advancePipeline(); this.pump(); }, options.tickMs || 10000);
    this.timer.unref();
    if (options.startHealth !== false) this.checkAce().catch(() => {});
  }

  importSeed(seedManifest) {
    if (seedManifest === false) return;
    const candidates = [seedManifest, path.resolve(__dirname, '../../public_upload_batches/us_2026_09_08/publish_manifest.json'), this.options.resourcesDir && path.join(this.options.resourcesDir, 'public_upload_batches/us_2026_09_08/publish_manifest.json')].filter(Boolean);
    const manifestFile = candidates.find(file => fs.existsSync(file));
    if (!manifestFile) return;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      for (const group of manifest.accounts || []) {
        const legacyAccountId = group.account === 'gleb-oxaj' ? 'gleb' : null;
        const account = this.state.accounts.find(a => a.handle === group.account || a.id === legacyAccountId);
        if (!account) continue;
        for (const item of group.tracks || []) {
          assert(path.basename(item.file) === item.file, 'Небезопасное имя файла в манифесте.');
          const candidates = [path.join(path.dirname(manifestFile), account.id, item.file), group.folder && path.join(group.folder, item.file)].filter(Boolean);
          const file = candidates.find(p => fs.existsSync(p));
          if (!file) { this.event(`Нет файла: ${item.file}`, 'warning', false); continue; }
          const info = audioInfo(file);
          if (this.state.tracks.some(t => t.checksum === info.checksum)) continue;
          const id = uid('track'), dest = path.join(this.rootData, 'audio', `${id}${path.extname(info.path).toLowerCase()}`);
          fs.copyFileSync(info.path, dest, fs.constants.COPYFILE_EXCL);
          this.state.tracks.push({ id, title: text(item.title, 100), accountId: account.id, ...info, path: fs.realpathSync(dest), modifiedAt: fs.statSync(dest).mtimeMs, status: 'ready', publishUrl: null, explicit: false, createdAt: now(), source: 'existing-batch' });
        }
      }
      this.event(`Импортировано треков: ${this.state.tracks.length}`, 'info', false);
    } catch (error) { this.event(`Импорт манифеста: ${error.message}`, 'error', false); }
  }

  recover() {
    if (!['restart', 'speed'].includes(this.state.settings?.memoryMode)) this.state.settings.memoryMode = 'restart';
    if (!this.state.settings.memoryPolicyVersion) {
      if (this.platform === 'darwin' && this.state.settings.memoryMode === 'restart') {
        this.state.settings.memoryMode = 'speed';
        this.state.events.unshift({ id: uid('event'), at: now(), level: 'info', message: 'ACE-Step: быстрый режим включён — без перезапуска между треками; сервис выключится после всей очереди.' });
      }
      this.state.settings.memoryPolicyVersion = 1;
    }
    const gleb = this.state.accounts.find(account => account.id === 'gleb');
    if (gleb?.handle === 'gleb-oxaj') {
      gleb.handle = 'nn1v-680019554';
      this.state.events.unshift({ id: uid('event'), at: now(), level: 'info', message: 'Gleb fps: SoundCloud-адрес обновлён по подтверждённому профилю Gleb Ohai — @nn1v-680019554.' });
    }
    this.state.ace = { online: false, status: 'unknown', owned: false };
    if (this.state.jobs.some(j => j.status === 'running')) this.state.paused = true;
    for (const account of this.state.accounts) { account.connected = false; account.lastSeen = null; }
    for (const job of this.state.jobs.filter(j => j.status === 'running')) {
      const generation = job.type === 'generate';
      job.status = generation ? 'failed' : 'uncertain';
      job.safeToRetry = generation;
      job.message = generation ? 'Генерация прервана закрытием приложения. Можно повторить.' : 'Приложение было закрыто во время операции. Проверьте результат в SoundCloud перед повтором.';
      for (const id of job.trackIds) {
        const track = this.state.tracks.find(t => t.id === id);
        if (track && !FINISHED_TRACKS.has(track.status)) track.status = generation ? 'generation_failed' : 'uncertain';
      }
    }
    if (this.state.pipeline?.active) Object.assign(this.state.pipeline, this.publicationSettings(this.selected(this.state.pipeline.trackIds), this.state.pipeline));
    this.save();
  }

  save() { writeJSON(this.stateFile, this.state); if (this.options.onEvent) this.options.onEvent(this.getState()); }
  event(message, level = 'info', persist = true) {
    this.state.events.unshift({ id: uid('event'), at: now(), level, message: text(message, 1500) });
    this.state.events = this.state.events.slice(0, 250);
    if (persist) this.save();
  }
  getState() {
    const state = clone(this.state);
    state.platform = this.platform;
    state.aceInstallation = inspectAceInstallation(state.settings.acePath, this.platform);
    for (const account of state.accounts) account.connected = !!account.lastSeen && Date.now() - Date.parse(account.lastSeen) < 45000;
    return state;
  }
  discoverAce() {
    return discoverAceInstallations({ platform: this.platform, roots: this.options.aceSearchRoots, homeDir: this.options.homeDir, environment: this.options.environment });
  }
  autoConfigureAce(notify = false) {
    if (inspectAceInstallation(this.state.settings?.acePath, this.platform).valid) return this.state.settings.acePath;
    const found = this.discoverAce();
    if (!found.length) return '';
    this.state.settings.acePath = found[0];
    if (this.platform === 'win32') this.state.settings.hardware = 'rtx4060';
    this.state.settings.memoryMode = this.state.settings.memoryMode || 'restart';
    if (notify) this.event(`ACE-Step найден автоматически: ${found[0]}`);
    else this.save();
    return found[0];
  }
  account(id) { const key = id === 'gleb-oxaj' ? 'gleb' : id; const account = this.state.accounts.find(a => a.id === key || a.handle === key); assert(account, 'Неизвестный аккаунт.'); return account; }
  selected(ids) {
    assert(Array.isArray(ids) && ids.length > 0 && ids.length <= 1000, 'Выберите треки.');
    const unique = [...new Set(ids)];
    const tracks = unique.map(id => this.state.tracks.find(t => t.id === id));
    assert(tracks.every(Boolean), 'Один из треков не найден.');
    return tracks;
  }
  busyTrack(id) { return this.state.jobs.some(j => LIVE_JOBS.has(j.status) && j.trackIds.includes(id)); }
  audioPath(id) {
    const track = this.state.tracks.find(t => t.id === id);
    assert(track && track.path, 'Аудио ещё не готово.');
    const actual = fs.realpathSync(track.path);
    assert(actual === track.path && AUDIO_EXTENSIONS.has(path.extname(actual).toLowerCase()) && fs.statSync(actual).isFile(), 'Аудиофайл перемещён или изменён. Импортируйте его заново.');
    return actual;
  }

  async action(name, payload = {}) {
    assert(!this.closed, 'Factory закрыта.');
    switch (name) {
      case 'importQueue': return this.importQueue(payload.tracks || payload.queue, payload.accountId);
      case 'importAudio': return this.importAudio(payload.paths, payload.accountId);
      case 'assign': {
        const account = this.account(payload.accountId), tracks = this.selected(payload.trackIds);
        assert(tracks.every(t => !this.busyTrack(t.id) && ['ready', 'planned', 'generation_failed'].includes(t.status)), 'Нельзя переназначить трек во время или после публикации.');
        for (const track of tracks) track.accountId = account.id;
        this.event(`Назначено ${tracks.length} треков → ${account.label}`); return this.getState();
      }
      case 'generate': return this.queueGeneration(payload);
      case 'runPipeline': return this.runPipeline(payload);
      case 'finishPipeline': return this.finishPipeline();
      case 'publish': case 'monetize': return this.queueExternal(name, payload);
      case 'pause': this.state.paused = true; this.event('Очередь приостановлена. Текущая операция завершится.'); return this.getState();
      case 'resume': this.state.paused = false; this.event('Очередь продолжена.'); this.advancePipeline(); this.pump(); return this.getState();
      case 'retry': return this.retry(payload.jobId);
      case 'reconcile': {
        const track = this.selected([payload.trackId])[0];
        assert(!this.busyTrack(track.id), 'Дождитесь завершения операции.');
        track.publishUrl = permalink(payload.publishUrl, this.account(track.accountId)); track.status = 'published'; track.updatedAt = now();
        for (const job of this.state.jobs.filter(j => j.status === 'uncertain' && j.type === 'publish' && j.trackIds.includes(track.id))) {
          if (job.trackIds.every(id => FINISHED_TRACKS.has(this.state.tracks.find(t => t.id === id).status))) { job.status = 'complete'; job.message = 'Результат проверен вручную по ссылкам.'; }
        }
        this.event(`Сохранена ссылка: ${track.title}`); return this.getState();
      }
      case 'markUnpublished': {
        const tracks = this.selected(payload.trackIds);
        assert(tracks.length && tracks.every(track => track.status === 'uncertain' && !track.publishUrl && !this.busyTrack(track.id)), 'Можно вернуть только неопределённые треки без сохранённой ссылки.');
        const jobs = this.state.jobs.filter(job => job.type === 'publish' && job.status === 'uncertain' && job.trackIds.some(id => tracks.some(track => track.id === id)));
        assert(jobs.length && jobs.every(job => !job.sideEffectStarted), 'Передача файлов уже могла начаться. Сначала проверьте SoundCloud и сохраните ссылки опубликованных треков.');
        for (const track of tracks) { track.status = 'ready'; track.message = ''; track.updatedAt = now(); }
        for (const job of jobs) if (job.trackIds.every(id => this.state.tracks.find(track => track.id === id)?.status !== 'uncertain')) {
          job.status = 'cancelled'; job.safeToRetry = false; job.finishedAt = now(); job.message = 'Пользователь подтвердил: файлы не передавались и треки не опубликованы.';
        }
        if (!this.state.jobs.some(job => ['running', 'queued', 'uncertain'].includes(job.status))) this.state.paused = false;
        this.event(`Возвращено в «Готово»: ${tracks.length}. Публикация не была начата.`); return this.getState();
      }
      case 'archive': {
        const tracks = this.selected(payload.trackIds);
        assert(tracks.every(t => !this.busyTrack(t.id) && !['uncertain', 'uploading', 'submitting'].includes(t.status)), 'Сначала завершите или проверьте текущую операцию.');
        for (const track of tracks) { track.previousStatus = track.status; track.status = 'archived'; track.archivedAt = now(); }
        this.event(`В архиве: ${tracks.length}. Аудиофайлы сохранены.`); return this.getState();
      }
      case 'restore': {
        for (const track of this.selected(payload.trackIds)) if (track.status === 'archived') { track.status = track.previousStatus || (track.path ? 'ready' : 'planned'); delete track.archivedAt; }
        this.event('Треки восстановлены из архива.'); return this.getState();
      }
      case 'settings': {
        const settings = { ...this.state.settings };
        if ('aceUrl' in payload) settings.aceUrl = localAceUrl(payload.aceUrl);
        if ('acePath' in payload) { assert(!payload.acePath || path.isAbsolute(payload.acePath), 'Укажите полный путь к ACE-Step.'); settings.acePath = text(payload.acePath, 2000); }
        if ('hardware' in payload) { assert(['mac', 'rtx4060'].includes(payload.hardware), 'Неизвестный профиль оборудования.'); settings.hardware = payload.hardware; }
        if ('memoryMode' in payload) { assert(['restart', 'speed'].includes(payload.memoryMode), 'Неизвестный режим памяти ACE-Step.'); settings.memoryMode = payload.memoryMode; }
        if ('artistName' in payload) settings.artistName = text(payload.artistName, 160);
        this.state.settings = settings; this.event('Настройки сохранены.'); return this.getState();
      }
      case 'detectAce': {
        const found = this.discoverAce();
        assert(found.length, 'ACE-Step с готовым окружением .venv не найден. Распакуйте или установите его в Documents, Downloads или Desktop либо нажмите «Выбрать папку».');
        this.state.settings.acePath = found[0];
        if (this.platform === 'win32') {
          this.state.settings.hardware = 'rtx4060';
          this.state.settings.memoryMode = 'restart';
        }
        this.event(`ACE-Step найден автоматически: ${found[0]}`);
        return { path: found[0], candidates: found, state: this.getState() };
      }
      case 'account': {
        const account = this.account(payload.id || payload.accountId), updated = { ...account };
        for (const field of ['artistName', 'mainArtist', 'legalName']) if (field in payload) updated[field] = text(payload[field], 160);
        if ('rightsConfirmed' in payload) { assert(typeof payload.rightsConfirmed === 'boolean', 'Некорректное подтверждение прав.'); updated.rightsConfirmed = payload.rightsConfirmed; }
        if ('songwriterRole' in payload) { assert(['writer', 'representative'].includes(payload.songwriterRole), 'Некорректная роль автора.'); updated.songwriterRole = payload.songwriterRole; }
        if ('contentRating' in payload) { assert(['Not Explicit', 'Explicit', 'Clean Edit'].includes(payload.contentRating), 'Некорректная маркировка.'); updated.contentRating = payload.contentRating; }
        if ('chromeProfile' in payload) { assert(/^(Default|Profile \d+)$/.test(payload.chromeProfile), 'Укажите Default или Profile N.'); updated.chromeProfile = payload.chromeProfile; }
        if ('handle' in payload) {
          const handle = text(payload.handle, 100).replace(/^@/, '');
          assert(/^[a-z0-9][a-z0-9_-]{2,99}$/i.test(handle), 'Укажите часть адреса SoundCloud после soundcloud.com/.');
          assert(!this.state.accounts.some(item => item.id !== account.id && item.handle.toLowerCase() === handle.toLowerCase()), 'Этот SoundCloud-адрес уже назначен другому аккаунту.');
          for (const track of this.state.tracks.filter(item => item.accountId === account.id && item.publishUrl)) permalink(track.publishUrl, { ...account, handle });
          updated.handle = handle;
        }
        Object.assign(account, updated); this.event(`Настройки аккаунта ${account.label} сохранены.`); return this.getState();
      }
      case 'startAce': return this.startAce();
      case 'stopAce': return this.stopAce();
      case 'restartAce': return this.restartAce();
      case 'checkAce': await this.checkAce(); return this.getState();
      case 'exportBackup': return this.exportBackup(payload.directory);
      case 'importBackup': return this.importBackup(payload.file || payload.directory);
      default: throw new Error('Неизвестное действие Factory.');
    }
  }

  importQueue(queue, defaultAccount) {
    assert(Array.isArray(queue) && queue.length > 0 && queue.length <= 300, 'JSON должен содержать массив от 1 до 300 треков.');
    const imported = [], skipped = [];
    const pending = queue.map((item, index) => {
      assert(item && typeof item === 'object' && !Array.isArray(item), `Трек ${index + 1}: неверный формат.`);
      const title = text(item.title || item.release_title || item.output_name, 180);
      const caption = text(item.caption, 4000), lyrics = text(item.lyrics, 20000);
      assert(title && caption, `Трек ${index + 1}: нужны title и caption.`);
      assert(title.length <= 100, `Трек ${index + 1}: название должно быть не длиннее 100 символов.`);
      const duration = Number(item.duration || 165), bpm = Number(item.bpm || 110);
      assert(Number.isFinite(duration) && duration >= 10 && duration <= 240, `${title}: длительность должна быть 10–240 секунд.`);
      assert(Number.isFinite(bpm) && bpm >= 30 && bpm <= 240, `${title}: BPM должен быть 30–240.`);
      const account = this.account(item.accountId || item.target_account || defaultAccount || this.state.accounts[index % 3].id);
      const albumTitle = item.album_title === undefined ? undefined : albumName(item.album_title);
      const input = { caption, lyrics, bpm, duration, key_scale: text(item.key_scale || 'C major', 40), time_signature: text(String(item.time_signature || '4'), 5), vocal_language: text(item.vocal_language || 'en', 20), audio_format: 'wav', batch_size: 1 };
      assert(['en', 'unknown'].includes(input.vocal_language), `${title}: для USA укажите язык en или unknown для инструментала.`);
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ title, accountId: account.id, ...input })).digest('hex');
      return { id: uid('track'), title, ...(albumTitle === undefined ? {} : { albumTitle }), accountId: account.id, path: null, duration, status: 'planned', publishUrl: null, explicit: item.explicit === true, input, fingerprint, createdAt: now() };
    });
    for (const track of pending) {
      if (this.state.tracks.some(t => t.fingerprint === track.fingerprint)) skipped.push(track.title);
      else { this.state.tracks.push(track); imported.push(track.id); }
    }
    this.event(`Добавлено в план: ${imported.length}. Повторов пропущено: ${skipped.length}.`);
    return { state: this.getState(), imported, skipped };
  }

  importAudio(paths, accountId) {
    assert(Array.isArray(paths) && paths.length > 0 && paths.length <= 300, 'Выберите от 1 до 300 аудиофайлов.');
    const account = this.account(accountId || 'bos');
    const infos = paths.map(audioInfo), imported = [], skipped = [];
    for (const info of infos) {
      if (this.state.tracks.some(t => t.checksum === info.checksum)) { skipped.push(path.basename(info.path)); continue; }
      const id = uid('track');
      const dest = path.join(this.rootData, 'audio', `${id}${path.extname(info.path).toLowerCase()}`);
      fs.copyFileSync(info.path, dest, fs.constants.COPYFILE_EXCL);
      const ownedInfo = { ...info, path: fs.realpathSync(dest), modifiedAt: fs.statSync(dest).mtimeMs };
      this.state.tracks.push({ id, title: path.basename(info.path, path.extname(info.path)).replace(/^\d+\s*[-_.]\s*/, '').slice(0, 100), accountId: account.id, ...ownedInfo, status: 'ready', publishUrl: null, explicit: false, createdAt: now() });
      imported.push(id);
    }
    this.event(`Импортировано аудио: ${imported.length}. Дубликатов пропущено: ${skipped.length}.`);
    return { state: this.getState(), imported, skipped };
  }

  publicationSettings(tracks, payload = {}) {
    assert(payload.amplify === undefined || typeof payload.amplify === 'boolean', 'Amplify должен быть включён или выключен.');
    assert(payload.albumTitles === undefined || (payload.albumTitles && typeof payload.albumTitles === 'object' && !Array.isArray(payload.albumTitles)), 'Названия альбомов должны быть указаны по аккаунтам.');
    for (const [id, title] of Object.entries(payload.albumTitles || {})) { this.account(id); albumName(title); }
    const albumTitles = {};
    for (const track of tracks) if (!Object.hasOwn(albumTitles, track.accountId)) albumTitles[track.accountId] = albumName(payload.albumTitles?.[track.accountId] ?? track.albumTitle ?? track.title);
    return { identityMode: 'paired-profile', uploadMode: 'album', albumTitles, amplify: payload.amplify ?? true };
  }
  externalJobSnapshot(type, tracks, options = {}) {
    if (type === 'generate') return {};
    if (type === 'monetize') return { identityMode: 'paired-profile' };
    assert(options.amplify === undefined || typeof options.amplify === 'boolean', 'Amplify должен быть включён или выключен.');
    return { identityMode: 'paired-profile', uploadMode: 'album', albumTitle: albumName(options.albumTitle ?? tracks[0]?.albumTitle ?? tracks[0]?.title), amplify: options.amplify ?? true };
  }
  makeJob(type, accountId, tracks, options = {}) {
    const job = { id: uid('job'), type, accountId, trackIds: tracks.map(t => t.id), ...this.externalJobSnapshot(type, tracks, options), status: 'queued', message: 'В очереди', createdAt: now(), progress: 0, safeToRetry: true };
    this.state.jobs.push(job); return job;
  }
  queueGeneration(payload) {
    const tracks = payload.trackIds ? this.selected(payload.trackIds) : this.state.tracks.filter(t => ['planned', 'generation_failed'].includes(t.status));
    assert(tracks.length > 0, 'Сначала импортируйте JSON с новыми треками.');
    assert(tracks.every(t => t.input && ['planned', 'generation_failed'].includes(t.status) && !this.busyTrack(t.id)), 'Генерация доступна для новых или неудавшихся треков.');
    this.acePython();
    for (const track of tracks) { this.makeJob('generate', track.accountId, [track]); track.status = 'generation_queued'; }
    this.event(`Генерация поставлена в очередь: ${tracks.length}.`); this.pump(); return this.getState();
  }
  queueExternal(type, payload) {
    const accountIds = [...new Set(payload.accountIds ? payload.accountIds.map(id => this.account(id).id) : this.state.accounts.map(a => a.id))];
    const eligible = type === 'publish' ? new Set(['ready']) : new Set(['published']);
    const tracks = payload.trackIds ? this.selected(payload.trackIds) : this.state.tracks.filter(t => accountIds.includes(t.accountId) && eligible.has(t.status) && !this.busyTrack(t.id));
    assert(tracks.length > 0, type === 'publish' ? 'Нет готовых треков для публикации.' : 'Нет опубликованных треков для монетизации.');
    assert(tracks.every(t => accountIds.includes(t.accountId) && eligible.has(t.status) && !this.busyTrack(t.id)), 'Выбранные треки уже в работе или ещё не готовы.');
    const publication = type === 'publish' ? this.publicationSettings(tracks, payload) : null;
    for (const track of tracks) {
      if (type === 'publish') {
        const info = audioInfo(this.audioPath(track.id));
        assert(info.checksum === track.checksum, `Файл ${track.title} изменился. Импортируйте новую версию.`);
      } else {
        const account = this.account(track.accountId);
        permalink(track.publishUrl, account);
        assert(account.rightsConfirmed && account.legalName && (account.mainArtist || account.artistName), `Заполните исполнителя, настоящее имя правообладателя и подтверждение прав для ${account.label}.`);
      }
    }
    for (const accountId of accountIds) {
      const group = tracks.filter(t => t.accountId === accountId);
      for (let i = 0; i < group.length; i += 100) {
        const batch = group.slice(i, i + 100);
        const snapshot = publication ? { albumTitle: group.length > 100 ? albumPart(publication.albumTitles[accountId], i / 100 + 1) : publication.albumTitles[accountId], amplify: publication.amplify } : {};
        this.makeJob(type, accountId, batch, snapshot);
        for (const track of batch) track.status = type === 'publish' ? 'publish_queued' : 'monetize_queued';
      }
    }
    this.event(`${type === 'publish' ? 'Публичная публикация' : 'Подача на монетизацию'}: ${tracks.length} треков в очереди.`);
    return this.getState();
  }

  bridgeHeartbeat(accountId, payload = {}) {
    const account = this.account(accountId); account.lastSeen = now(); account.connected = true;
    account.bridgeError = null; account.bridgeVersion = text(payload.version, 40) || account.bridgeVersion || null;
    if ('observedHandle' in payload) account.observedHandle = text(payload.observedHandle, 100) || null;
    account.identityVerified = account.observedHandle?.toLowerCase() === account.handle.toLowerCase();
    const active = this.state.jobs.find(j => j.status === 'running' && j.accountId === account.id && j.type !== 'generate');
    if (active) active.lastHeartbeat = now();
    this.save(); return { ok: true, paused: this.state.paused, account: clone(account) };
  }
  bridgeRejected(accountId, version) {
    const account = this.account(accountId), message = `Bridge ${text(version, 40) || 'без версии'} несовместим с Factory.`;
    account.bridgeError = message; account.bridgeLastAttempt = now(); account.connected = false;
    if (account.lastBridgeErrorEvent !== message) {
      account.lastBridgeErrorEvent = message;
      this.event(`${account.label}: ${message}`, 'warning', false);
    }
    this.save(); return { ok: false, message };
  }
  noteDispatch(jobId, error = '') {
    const job = this.state.jobs.find(item => item.id === jobId && item.status === 'queued' && item.type !== 'generate');
    if (!job) return null;
    job.dispatchAttempts = (job.dispatchAttempts || 0) + 1; job.lastDispatchAt = now();
    job.message = error ? `Не удалось открыть Chrome: ${text(error, 500)}`
      : `Открываю Chrome-профиль ${this.account(job.accountId).chromeProfile} один раз; ожидаю Music Factory Bridge`;
    this.save(); return clone(job);
  }
  claimJob(accountId) {
    const account = this.account(accountId); this.checkLeases();
    if (this.state.paused || this.closed || this.state.jobs.some(j => j.status === 'running')) return null;
    const job = this.state.jobs.find(j => j.status === 'queued');
    if (!job || job.type === 'generate' || job.accountId !== account.id) { this.pump(); return null; }
    Object.assign(job, this.externalJobSnapshot(job.type, this.selected(job.trackIds), job));
    job.status = 'running'; job.startedAt = now(); job.lastHeartbeat = now(); job.message = job.type === 'publish' ? 'Подготовка загрузки альбома' : 'Подготовка подачи на монетизацию'; job.safeToRetry = false;
    account.lastSeen = now(); account.connected = true;
    this.save();
    return { ...clone(job), account: clone(account), handle: account.handle, artistName: account.artistName || account.mainArtist, visibility: 'public', tracks: job.trackIds.map(id => {
      const track = this.state.tracks.find(t => t.id === id);
      return { id: track.id, title: track.title, publishUrl: track.publishUrl, duration: track.duration, filename: `${track.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')}${path.extname(track.path || '.wav')}`, audioUrl: `/bridge/audio/${encodeURIComponent(track.id)}`, explicit: track.explicit, rightsConfirmed: account.rightsConfirmed, songwriterRole: account.songwriterRole, legalName: account.legalName, mainArtist: account.mainArtist || account.artistName, contentRating: track.explicit ? 'Explicit' : account.contentRating, isrc: track.isrc || null };
    }) };
  }

  reportJob(accountId, jobId, payload = {}) {
    const account = this.account(accountId), job = this.state.jobs.find(j => j.id === jobId);
    assert(job && job.accountId === account.id && job.type !== 'generate', 'Задание не принадлежит этому аккаунту.');
    assert(['progress', 'complete', 'failed', 'blocked', 'uncertain'].includes(payload.status), 'Некорректный статус задания.');
    if (payload.reportId && (job.appliedReportIds || []).includes(payload.reportId)) return { ok: true, duplicate: true };
    if (job.status !== 'running') {
      if (job.reportId && payload.reportId === job.reportId) return { ok: true, duplicate: true };
      // A Bridge may retain a terminal pre-upload report while the desktop app is
      // closed. If the user has since confirmed that no upload started, acknowledge
      // that empty stale report so the profile can release its local lock and claim
      // the next queued job. Never accept this shortcut after a side-effect checkpoint.
      if (job.type === 'publish' && job.status === 'cancelled' && !job.sideEffectStarted &&
          ['blocked', 'failed'].includes(payload.status) && payload.safeToRetry === true &&
          Array.isArray(payload.tracks) && payload.tracks.length === 0) return { ok: true, stale: true };
      throw new Error('Задание уже завершено или потеряло соединение. Проверьте результат в SoundCloud.');
    }
    const updates = payload.tracks || [];
    assert(Array.isArray(updates), 'Некорректный отчёт по трекам.');
    const seen = new Set();
    const validated = updates.map(item => {
      const id = item.id || item.trackId;
      assert(job.trackIds.includes(id) && !seen.has(id), 'Отчёт содержит чужой или повторный trackId.'); seen.add(id);
      const track = this.state.tracks.find(t => t.id === id);
      assert(track && track.accountId === account.id, 'Трек не принадлежит аккаунту.');
      const allowed = job.type === 'publish' ? ['uploading', 'published', 'failed', 'uncertain'] : ['submitting', 'submitted', 'monetizing', 'rejected', 'failed', 'uncertain'];
      assert(allowed.includes(item.status), 'Некорректный статус трека.');
      assert(!FINISHED_TRACKS.has(track.status) || FINISHED_TRACKS.has(item.status), 'Нельзя отменить уже подтверждённый результат трека.');
      const url = item.publishUrl || item.url;
      return { track, status: item.status, publishUrl: item.status === 'published' ? permalink(url, account) : undefined, message: text(item.message, 1000) };
    });
    if (validated.some(u => ['uploading', 'submitting', 'published', 'submitted', 'monetizing'].includes(u.status))) job.sideEffectStarted = true;
    for (const update of validated) {
      update.track.status = update.status;
      if (update.publishUrl) update.track.publishUrl = update.publishUrl;
      update.track.message = update.message; update.track.updatedAt = now();
    }
    job.message = text(payload.message, 1500) || job.message; job.lastHeartbeat = now();
    if (payload.reportId) job.appliedReportIds = [...(job.appliedReportIds || []), text(payload.reportId, 100)].slice(-400);
    job.progress = job.trackIds.filter(id => FINISHED_TRACKS.has(this.state.tracks.find(t => t.id === id).status)).length / job.trackIds.length;
    if (payload.status !== 'progress') {
      const safe = !job.sideEffectStarted && payload.safeToRetry === true && validated.every(u => u.status === 'failed') && !job.trackIds.some(id => ['uploading', 'submitting', 'published', 'submitted', 'monetizing', 'uncertain'].includes(this.state.tracks.find(t => t.id === id).status));
      for (const id of job.trackIds) {
        const track = this.state.tracks.find(t => t.id === id);
        if (!FINISHED_TRACKS.has(track.status)) track.status = safe ? (job.type === 'publish' ? 'ready' : 'published') : 'uncertain';
      }
      const uncertain = job.trackIds.some(id => this.state.tracks.find(t => t.id === id).status === 'uncertain');
      job.status = uncertain ? 'uncertain' : payload.status === 'complete' ? 'complete' : payload.status;
      job.safeToRetry = safe; job.finishedAt = now(); job.reportId = payload.reportId || null;
      this.event(`${account.label}: ${job.message}`, uncertain || ['failed', 'blocked'].includes(job.status) ? 'warning' : 'info', false);
    }
    this.save(); this.advancePipeline(); this.pump(); return { ok: true, job: clone(job) };
  }

  retry(jobId) {
    const job = this.state.jobs.find(j => j.id === jobId);
    assert(job && ['failed', 'blocked'].includes(job.status) && job.safeToRetry, 'Автоповтор недоступен: сначала проверьте, не опубликованы ли треки, и сохраните их ссылки.');
    const tracks = this.selected(job.trackIds).filter(t => job.type === 'generate' ? t.status === 'generation_failed' : job.type === 'publish' ? t.status === 'ready' : t.status === 'published');
    assert(tracks.length > 0 && tracks.every(t => !this.busyTrack(t.id)), 'Нет доступных треков для повтора.');
    this.makeJob(job.type, job.accountId, tracks, job); job.retriedAt = now();
    for (const track of tracks) track.status = job.type === 'generate' ? 'generation_queued' : job.type === 'publish' ? 'publish_queued' : 'monetize_queued';
    this.event('Повтор добавлен в очередь.'); this.pump(); return this.getState();
  }
  checkLeases() {
    let changed = false;
    for (const job of this.state.jobs.filter(j => j.status === 'running' && j.type !== 'generate')) {
      if (Date.now() - Date.parse(job.lastHeartbeat || job.startedAt) < (this.options.leaseMs || 120000)) continue;
      job.status = 'uncertain'; job.safeToRetry = false; job.message = 'Связь с Chrome потеряна. Проверьте результат в SoundCloud, чтобы избежать повторной загрузки.';
      for (const id of job.trackIds) { const track = this.state.tracks.find(t => t.id === id); if (!FINISHED_TRACKS.has(track.status)) track.status = 'uncertain'; }
      this.event(job.message, 'warning', false); changed = true;
    }
    if (changed) this.save();
  }

  acePython() {
    const dir = this.state.settings.acePath;
    assert(dir && fs.existsSync(path.join(dir, 'acestep', 'acestep_v15_pipeline.py')), 'В настройках выберите папку установленного ACE-Step 1.5.');
    const python = acePythonPath(dir, this.platform);
    assert(fs.existsSync(python), 'В ACE-Step не найдено окружение .venv. Сначала установите ACE-Step по инструкции.');
    return python;
  }
  async checkAce() {
    if (this.closed || this.checkingAce) return;
    this.checkingAce = true;
    try {
      const response = await fetch(`${localAceUrl(this.state.settings.aceUrl)}/config`, { signal: AbortSignal.timeout(2500), redirect: 'error' });
      const config = await response.json();
      const online = response.ok && Array.isArray(config.components) && Array.isArray(config.dependencies);
      const changed = this.state.ace.online !== online;
      this.state.ace = { ...this.state.ace, online, status: online ? 'ready' : this.aceProcess ? 'starting' : 'offline', checkedAt: now(), owned: !!this.aceProcess };
      if (changed) this.save();
    } catch {
      const changed = this.state.ace.online !== false || this.state.ace.status === 'unknown';
      this.state.ace = { ...this.state.ace, online: false, status: this.aceProcess ? 'starting' : 'offline', checkedAt: now(), owned: !!this.aceProcess };
      if (changed) this.save();
    } finally { this.checkingAce = false; }
  }
  async startAce() {
    await this.checkAce();
    if (this.state.ace.online || this.aceProcess) return this.getState();
    const python = this.acePython(), settings = this.state.settings, url = new URL(localAceUrl(settings.aceUrl));
    const rtx = settings.hardware === 'rtx4060';
    const args = ['-u', '-c', 'from acestep.acestep_v15_pipeline import main; main()', '--port', url.port || '80', '--server-name', url.hostname, '--language', 'en', '--config_path', 'acestep-v15-turbo', '--init_llm', 'false', '--init_service', 'true', '--batch_size', '1', '--backend', rtx ? 'pt' : 'mlx', '--offload_to_cpu', rtx ? 'true' : 'false', '--offload_dit_to_cpu', rtx ? 'true' : 'false'];
    const logPath = path.join(this.rootData, 'logs', 'ace-step.log');
    const log = fs.openSync(logPath, 'a', 0o600);
    const runtimeCache = path.join(settings.acePath, '.runtime-cache');
    const aceEnv = {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      HF_HOME: path.join(runtimeCache, 'huggingface'),
      HUGGINGFACE_HUB_CACHE: path.join(runtimeCache, 'huggingface', 'hub'),
      MODELSCOPE_CACHE: path.join(runtimeCache, 'modelscope'),
      MPLCONFIGDIR: path.join(runtimeCache, 'matplotlib')
    };
    const child = spawn(python, args, { cwd: settings.acePath, env: aceEnv, windowsHide: true, stdio: ['ignore', log, log] });
    fs.closeSync(log); this.aceProcess = child;
    this.state.ace = { online: false, status: 'starting', owned: true, logPath };
    const stopped = error => { if (this.aceProcess !== child) return; this.aceProcess = null; if (this.closed) return; this.state.ace = { ...this.state.ace, online: false, status: 'offline', owned: false }; this.event(`ACE-Step остановлен${error ? `: ${error.message || error}` : ''}. Журнал: ${logPath}`, error ? 'error' : 'info'); this.advancePipeline(); };
    child.once('error', stopped); child.once('exit', (code) => stopped(code ? `код ${code}` : null));
    this.event(`ACE-Step запускается: ${rtx ? 'RTX 4060, 8 ГБ, batch 1, CPU offload' : 'Apple Silicon, batch 1'}.`);
    return this.getState();
  }
  stopAce() {
    assert(!this.worker, 'Дождитесь окончания текущего трека. Можно поставить очередь на паузу.');
    assert(this.aceProcess, 'Этот ACE-Step был запущен вне Factory. Завершите его в исходном окне.');
    this.aceProcess.kill(); this.event('ACE-Step: отправлена команда завершения.'); return this.getState();
  }
  async terminateOwnedAce(message) {
    const child = this.aceProcess;
    if (!child) return;
    this.aceProcess = null;
    let exited = false;
    const done = new Promise(resolve => {
      const finish = () => { exited = true; resolve(); };
      child.once('exit', finish); child.once('error', finish);
    });
    try { child.kill('SIGTERM'); } catch { exited = true; }
    await Promise.race([done, new Promise(resolve => setTimeout(resolve, this.options.aceStopMs || 10000))]);
    if (!exited) {
      try { child.kill('SIGKILL'); } catch {}
      await Promise.race([done, new Promise(resolve => setTimeout(resolve, 2000))]);
    }
    this.state.ace = { ...this.state.ace, online: false, status: 'offline', owned: false };
    this.event(message);
  }
  async waitForAceReady(timeoutMs = this.options.aceStartupMs || 180000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await this.checkAce();
      if (this.state.ace.online) return this.getState();
      if (!this.aceProcess) throw new Error('ACE-Step завершился во время загрузки моделей. Проверьте журнал.');
      await new Promise(resolve => setTimeout(resolve, this.options.acePollMs || 1000));
    }
    throw new Error('ACE-Step не успел загрузить модели за 3 минуты. Очередь поставлена на паузу; проверьте журнал и свободную память.');
  }
  async restartAce() {
    if (!this.aceProcess) return this.getState();
    this.event('Перезапуск ACE-Step для полного сброса памяти GPU...');
    await this.terminateOwnedAce('Память ACE-Step освобождена. Запускаю модели для следующего трека...');
    await this.startAce();
    return this.waitForAceReady();
  }
  pump() {
    if (this.closed || this.pumping || this.state.paused || this.state.jobs.some(j => j.status === 'running')) return;
    const job = this.state.jobs.find(j => j.status === 'queued');
    if (!job || job.type !== 'generate') return;
    this.pumping = true;
    this.runGeneration(job).catch(error => { this.event(`Генерация: ${error.message}`, 'error'); }).finally(() => { this.pumping = false; if (!this.closed) setImmediate(() => this.pump()); });
  }
  async runGeneration(job) {
    const track = this.state.tracks.find(t => t.id === job.trackIds[0]);
    job.status = 'running'; job.startedAt = now(); track.status = 'generating'; job.message = `Генерация: ${track.title}`; this.save();
    try {
      await this.checkAce();
      assert(this.state.ace.online, 'ACE-Step не отвечает. Нажмите «Запустить ACE-Step», дождитесь готовности и повторите задание.');
      const requestPath = path.join(this.rootData, 'jobs', `${job.id}.json`);
      const outputPath = path.join(this.rootData, 'audio', `${track.id}.wav`);
      writeJSON(requestPath, { server: localAceUrl(this.state.settings.aceUrl), track: track.input, output: outputPath });
      const worker = spawn(this.acePython(), ['-u', path.join(__dirname, 'generate.py'), requestPath], { cwd: this.rootData, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      this.worker = worker;
      let pending = '', errorText = '', result = null;
      const parseLine = line => { try { const item = JSON.parse(line); if (item.type === 'complete') result = item; if (item.type === 'progress') { job.message = text(item.message, 1000); this.save(); } if (item.type === 'error') errorText = text(item.message, 2000); } catch {} };
      worker.stdout.on('data', chunk => { pending += chunk.toString(); const lines = pending.split('\n'); pending = lines.pop().slice(-100000); lines.forEach(parseLine); });
      worker.stderr.on('data', chunk => { errorText = (errorText + chunk).slice(-6000); });
      const code = await new Promise((resolve, reject) => { worker.once('error', reject); worker.once('close', resolve); });
      if (pending) parseLine(pending); this.worker = null;
      assert(code === 0 && result && fs.existsSync(outputPath), errorText || 'ACE-Step не вернул аудиофайл.');
      const info = audioInfo(outputPath);
      assert(info.duration > 0, 'Получен пустой WAV.');
      assert(!this.state.tracks.some(t => t.id !== track.id && t.checksum === info.checksum), 'ACE-Step вернул точную копию существующего аудио. Трек не добавлен повторно.');
      Object.assign(track, info, { status: 'ready', updatedAt: now() }); job.status = 'complete'; job.progress = 1; job.message = `${track.title}: готово`; job.finishedAt = now();
      this.event(job.message);
      if (this.aceProcess) {
        const more = this.state.jobs.some(item => item.type === 'generate' && item.status === 'queued');
        try {
          if (!more) await this.terminateOwnedAce('Генерация завершена. ACE-Step остановлен, память освобождена.');
          else if ((this.state.settings.memoryMode || 'restart') === 'restart') await this.restartAce();
        } catch (e) {
          this.state.paused = true;
          this.event(`ACE-Step не готов к следующему треку: ${e.message}`, 'warning');
        }
      }
    } catch (error) {
      this.worker = null; track.status = 'generation_failed'; track.message = text(error.message, 2000); job.status = 'failed'; job.safeToRetry = true; job.message = text(error.message, 2000); job.finishedAt = now();
      this.state.paused = true;
      this.event(`${track.title}: ${error.message}`, 'error');
    }
    this.advancePipeline();
  }
  async runPipeline(payload) {
    assert(!this.state.pipeline || !this.state.pipeline.active, 'Полный цикл уже запущен. Продолжите или завершите текущую очередь.');
    const accountIds = [...new Set(payload.accountIds ? payload.accountIds.map(id => this.account(id).id) : this.state.accounts.map(a => a.id))];
    const tracks = payload.trackIds ? this.selected(payload.trackIds) : this.state.tracks.filter(t => accountIds.includes(t.accountId) && !['archived', 'submitted', 'monetizing', 'rejected'].includes(t.status));
    assert(tracks.length && tracks.every(t => accountIds.includes(t.accountId) && ['planned', 'generation_failed', 'ready', 'published'].includes(t.status) && !this.busyTrack(t.id)), 'Для полного цикла выберите новые, готовые или опубликованные треки без активного задания.');
    const publication = this.publicationSettings(tracks, payload);
    const monetize = payload.monetize === true;
    if (monetize) for (const id of [...new Set(tracks.map(t => t.accountId))]) {
      const account = this.account(id);
      assert(account.rightsConfirmed && account.legalName && (account.mainArtist || account.artistName), `Для монетизации заполните исполнителя, настоящее имя и права в аккаунте ${account.label}.`);
    }
    const needsGeneration = tracks.some(t => ['planned', 'generation_failed'].includes(t.status));
    if (needsGeneration) { this.acePython(); await this.checkAce(); if (!this.state.ace.online) await this.startAce(); }
    for (const track of tracks) if (track.status === 'generation_failed') track.status = 'planned';
    this.state.pipeline = { id: uid('pipeline'), active: true, ...publication, stage: needsGeneration && !this.state.ace.online ? 'waiting_ace' : 'generation', trackIds: tracks.map(t => t.id), accountIds, monetize, createdAt: now(), message: needsGeneration ? 'Подготовка генерации' : 'Подготовка публикации' };
    this.state.paused = false;
    this.event(`Полный цикл запущен: ${tracks.length} треков${monetize ? ', с подачей на монетизацию' : ''}.`);
    this.advancePipeline(); return this.getState();
  }
  finishPipeline() {
    const pipeline = this.state.pipeline;
    assert(pipeline?.active, 'Сейчас нет активного полного цикла.');
    const ids = new Set(pipeline.trackIds || []);
    const running = this.state.jobs.filter(job => job.status === 'running' && job.trackIds.some(id => ids.has(id)));
    assert(!running.length, 'Текущая операция уже выполняется. Дождитесь её завершения, затем завершите цикл.');
    let cancelled = 0;
    for (const job of this.state.jobs.filter(job => job.status === 'queued' && job.trackIds.every(id => ids.has(id)))) {
      job.status = 'cancelled'; job.safeToRetry = false; job.finishedAt = now(); job.message = 'Отменено при ручном завершении полного цикла.'; cancelled++;
      const restored = job.type === 'generate' ? 'planned' : job.type === 'publish' ? 'ready' : 'published';
      const queued = job.type === 'generate' ? 'generation_queued' : job.type === 'publish' ? 'publish_queued' : 'monetize_queued';
      for (const id of job.trackIds) {
        const track = this.state.tracks.find(item => item.id === id);
        if (track?.status === queued) track.status = restored;
      }
    }
    pipeline.active = false; pipeline.stage = 'cancelled'; pipeline.finishedAt = now();
    pipeline.message = cancelled ? `Цикл завершён вручную. Отменено заданий: ${cancelled}.` : 'Цикл завершён вручную.';
    this.state.paused = false;
    this.event(pipeline.message, 'warning'); this.pump(); return this.getState();
  }
  advancePipeline() {
    const pipeline = this.state.pipeline;
    if (this.closed || this.state.paused || !pipeline || !pipeline.active || this.advancing) return;
    this.advancing = true;
    try {
      const tracks = this.selected(pipeline.trackIds);
      if (tracks.some(t => ['uncertain', 'generation_failed', 'failed'].includes(t.status))) {
        pipeline.previousStage = pipeline.stage === 'attention' ? pipeline.previousStage : pipeline.stage;
        pipeline.stage = 'attention'; pipeline.message = 'Требуется проверка ошибки перед продолжением'; this.state.paused = true; this.save(); return;
      }
      if (pipeline.stage === 'attention') pipeline.stage = pipeline.previousStage || 'generation';
      if (pipeline.stage === 'waiting_ace') {
        if (!this.state.ace.online && this.state.ace.status === 'offline' && !this.aceProcess) {
          pipeline.previousStage = 'waiting_ace'; pipeline.stage = 'attention'; pipeline.message = 'ACE-Step завершился до готовности. Откройте журнал ACE-Step, устраните ошибку и запустите его снова.';
          this.state.paused = true; this.event(pipeline.message, 'error'); return;
        }
        if (!this.state.ace.online) return;
        pipeline.stage = 'generation';
      }
      if (pipeline.stage === 'generation') {
        const planned = tracks.filter(t => t.status === 'planned' && !this.busyTrack(t.id));
        if (planned.length) { this.queueGeneration({ trackIds: planned.map(t => t.id) }); return; }
        if (tracks.some(t => ['generation_queued', 'generating'].includes(t.status))) return;
        pipeline.stage = 'publishing'; pipeline.message = 'Публичная загрузка по аккаунтам';
        const ready = tracks.filter(t => t.status === 'ready');
        if (ready.length) { this.queueExternal('publish', { accountIds: pipeline.accountIds, trackIds: ready.map(t => t.id), albumTitles: pipeline.albumTitles, amplify: pipeline.amplify }); return; }
      }
      if (pipeline.stage === 'publishing') {
        if (tracks.some(t => ['publish_queued', 'uploading'].includes(t.status))) return;
        const ready = tracks.filter(t => t.status === 'ready');
        if (ready.length) {
          // A safe pre-upload failure must be retried by the user, not looped.
          pipeline.previousStage = 'publishing'; pipeline.stage = 'attention'; pipeline.message = 'Публикация остановлена до загрузки. Проверьте журнал и повторите задание.'; this.state.paused = true; this.save(); return;
        }
        pipeline.stage = 'monetizing'; pipeline.message = 'Подача опубликованных треков на монетизацию';
        const published = tracks.filter(t => t.status === 'published');
        if (pipeline.monetize && published.length) { this.queueExternal('monetize', { accountIds: pipeline.accountIds, trackIds: published.map(t => t.id) }); return; }
      }
      if (pipeline.stage === 'monetizing') {
        if (tracks.some(t => ['monetize_queued', 'submitting'].includes(t.status))) return;
        if (pipeline.monetize && tracks.some(t => t.status === 'published')) { pipeline.previousStage = 'monetizing'; pipeline.stage = 'attention'; pipeline.message = 'Подача на монетизацию остановлена. Проверьте журнал.'; this.state.paused = true; this.save(); return; }
        pipeline.active = false; pipeline.stage = 'complete'; pipeline.finishedAt = now(); pipeline.message = pipeline.monetize ? 'Загрузка и подача завершены. Одобрение остаётся за SoundCloud.' : 'Публичная загрузка завершена.'; this.event(pipeline.message);
      }
    } catch (error) {
      pipeline.previousStage = pipeline.stage; pipeline.stage = 'attention'; pipeline.message = text(error.message, 1500); this.state.paused = true; this.event(error.message, 'error');
    } finally { this.advancing = false; }
  }
  exportBackup(directory) {
    assert(typeof directory === 'string' && path.isAbsolute(directory) && fs.statSync(directory).isDirectory(), 'Выберите папку для резервной копии.');
    assert(!this.state.jobs.some(j => j.status === 'running'), 'Дождитесь окончания текущей операции перед резервным копированием.');
    const dest = path.join(directory, `Music-Factory-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    fs.mkdirSync(dest); fs.mkdirSync(path.join(dest, 'audio'));
    const tracks = clone(this.state.tracks);
    for (const track of tracks) {
      if (!track.path) continue;
      const source = this.audioPath(track.id), relative = `audio/${track.id}${path.extname(source).toLowerCase()}`;
      fs.copyFileSync(source, path.join(dest, relative), fs.constants.COPYFILE_EXCL); track.path = relative;
    }
    const accounts = this.state.accounts.map(({ id, label, handle, artistName, legalName, mainArtist, songwriterRole, contentRating }) => ({ id, label, handle, artistName, legalName, mainArtist, songwriterRole, contentRating }));
    writeJSON(path.join(dest, 'factory-backup.json'), { format: 'music-factory-backup', version: 1, createdAt: now(), settings: { artistName: this.state.settings.artistName }, accounts, tracks });
    this.event(`Резервная копия готова: ${dest}`);
    return { directory: dest, file: path.join(dest, 'factory-backup.json'), trackCount: tracks.length, state: this.getState() };
  }
  importBackup(fileOrDirectory) {
    assert(typeof fileOrDirectory === 'string' && path.isAbsolute(fileOrDirectory), 'Выберите файл factory-backup.json или его папку.');
    assert(!this.state.jobs.some(j => j.status === 'running'), 'Дождитесь окончания текущей операции перед восстановлением.');
    const file = fs.statSync(fileOrDirectory).isDirectory() ? path.join(fileOrDirectory, 'factory-backup.json') : fileOrDirectory;
    const backupRoot = fs.realpathSync(path.dirname(file));
    const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert(backup.format === 'music-factory-backup' && backup.version === 1 && Array.isArray(backup.tracks) && backup.tracks.length <= 10000, 'Неизвестный формат резервной копии.');
    const pending = backup.tracks.map(item => {
      const account = this.account(item.accountId);
      assert(text(item.title, 180) && item.title.trim().length <= 100, 'В копии найден трек без названия или с названием длиннее 100 символов.');
      let info = null;
      if (item.path) {
        assert(typeof item.path === 'string' && !path.isAbsolute(item.path) && !item.path.includes('\\'), 'В копии должен быть относительный путь к аудио.');
        const source = fs.realpathSync(path.resolve(backupRoot, item.path));
        assert(source.startsWith(backupRoot + path.sep), 'Аудио выходит за пределы папки резервной копии.');
        info = audioInfo(source);
        assert(!item.checksum || info.checksum === item.checksum, `Контрольная сумма не совпала: ${item.title}`);
      }
      let status = item.status;
      if (['publish_queued', 'uploading', 'monetize_queued', 'submitting'].includes(status)) status = 'uncertain';
      if (['generating', 'generation_queued', 'generation_failed'].includes(status)) status = 'planned';
      assert(['ready', 'planned', 'published', 'submitted', 'monetizing', 'rejected', 'uncertain', 'archived'].includes(status), 'Неизвестный статус в копии.');
      const publishUrl = item.publishUrl ? permalink(item.publishUrl, account) : null;
      assert(!['published', 'submitted', 'monetizing', 'rejected'].includes(status) || publishUrl, 'Нет ссылки у опубликованного трека.');
      const track = { id: uid('track'), title: text(item.title, 100), accountId: account.id, path: null, status, publishUrl, explicit: item.explicit === true, createdAt: item.createdAt || now(), input: item.input || null, fingerprint: item.fingerprint || null, previousStatus: ['ready', 'planned', 'published', 'submitted', 'monetizing', 'rejected'].includes(item.previousStatus) ? item.previousStatus : null };
      if (item.albumTitle !== undefined) track.albumTitle = albumName(item.albumTitle);
      return { track, info };
    });
    let imported = 0, skipped = 0;
    for (const { track, info } of pending) {
      if (this.state.tracks.some(t => (info && t.checksum === info.checksum) || (track.fingerprint && t.fingerprint === track.fingerprint))) { skipped++; continue; }
      if (info) {
        const dest = path.join(this.rootData, 'audio', `${track.id}${path.extname(info.path).toLowerCase()}`);
        fs.copyFileSync(info.path, dest, fs.constants.COPYFILE_EXCL);
        Object.assign(track, info, { path: fs.realpathSync(dest), modifiedAt: fs.statSync(dest).mtimeMs });
      }
      this.state.tracks.push(track); imported++;
    }
    for (const saved of Array.isArray(backup.accounts) ? backup.accounts : []) {
      const account = this.state.accounts.find(a => a.id === saved.id && a.handle === saved.handle);
      if (!account) continue;
      for (const key of ['artistName', 'legalName', 'mainArtist']) if (!account[key]) account[key] = text(saved[key], 160);
      if (!account.songwriterRole && ['writer', 'representative'].includes(saved.songwriterRole)) account.songwriterRole = saved.songwriterRole;
      if (!account.contentRating && ['Not Explicit', 'Explicit', 'Clean Edit'].includes(saved.contentRating)) account.contentRating = saved.contentRating;
      // Rights are confirmed in this installation; a backup cannot confer them.
    }
    if (!this.state.settings.artistName) this.state.settings.artistName = text(backup.settings?.artistName, 160);
    this.state.paused = true;
    this.event(`Восстановлено: ${imported}; дубликатов пропущено: ${skipped}. Очередь на паузе.`);
    return { imported, skipped, state: this.getState() };
  }
  close() {
    if (this.closed) return;
    this.closed = true; clearInterval(this.timer);
    this.save();
    if (this.worker) this.worker.kill();
    if (this.aceProcess) this.aceProcess.kill();
  }
}

module.exports = { Factory, audioInfo, localAceUrl, permalink, writeJSON, acePythonPath, inspectAceInstallation, discoverAceInstallations };
