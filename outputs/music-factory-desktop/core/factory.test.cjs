'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Factory, audioInfo, localAceUrl, permalink, inspectAceInstallation, discoverAceInstallations } = require('./factory.cjs');

function setup(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-core-test-')));
  const options = { seedManifest: false, startHealth: false, tickMs: 1000000 };
  const factory = new Factory(path.join(root, 'data'), options);
  const factories = [factory];
  t.after(() => { factories.forEach(f => f.close()); fs.rmSync(root, { recursive: true, force: true }); });
  const wav = (name, seed = 1) => {
    const file = path.join(root, `${name}.wav`), buffer = Buffer.alloc(44 + 2048);
    buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVE', 8); buffer.write('fmt ', 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(8000, 24); buffer.writeUInt32LE(16000, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(2048, 40); buffer.fill(seed, 44); fs.writeFileSync(file, buffer); return file;
  };
  const add = async (account = 'bos', name = account, seed = 1) => (await factory.action('importAudio', { paths: [wav(name, seed)], accountId: account })).imported[0];
  return { root, factory, wav, add, register: f => factories.push(f), reopen: () => { factory.close(); const f = new Factory(path.join(root, 'data'), options); factories.push(f); return f; } };
}

test('audio import owns copies, recognizes RIFF duration and deduplicates by content across accounts', async t => {
  const { factory, add, wav, root } = setup(t), id = await add();
  const track = factory.getState().tracks[0];
  assert.equal(track.duration, 0.13); assert.ok(track.path.startsWith(path.join(root, 'data', 'audio')));
  const duplicate = await factory.action('importAudio', { paths: [wav('renamed-same', 1)], accountId: 'rivi' });
  assert.equal(duplicate.imported.length, 0); assert.equal(duplicate.skipped.length, 1); assert.equal(factory.audioPath(id), track.path);
  fs.unlinkSync(path.join(root, 'bos.wav')); assert.ok(fs.existsSync(factory.audioPath(id)));
});

test('Windows startup discovers only a complete ACE-Step installation and selects RTX 4060 safely', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-windows-ace-')));
  const documents = path.join(root, 'Documents'), ace = path.join(documents, 'ACE-Step-1.5');
  fs.mkdirSync(path.join(ace, 'acestep'), { recursive: true });
  fs.mkdirSync(path.join(ace, '.venv', 'Scripts'), { recursive: true });
  fs.writeFileSync(path.join(ace, 'acestep', 'acestep_v15_pipeline.py'), '# test');
  fs.writeFileSync(path.join(ace, '.venv', 'Scripts', 'python.exe'), 'test');
  assert.equal(inspectAceInstallation(ace, 'win32').valid, true);
  assert.deepEqual(discoverAceInstallations({ platform: 'win32', roots: [documents] }), [fs.realpathSync(ace)]);
  const factory = new Factory(path.join(root, 'data'), { seedManifest: false, startHealth: false, tickMs: 1000000, platform: 'win32', aceSearchRoots: [documents] });
  t.after(() => { factory.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const state = factory.getState();
  assert.equal(state.settings.acePath, fs.realpathSync(ace));
  assert.equal(state.settings.hardware, 'rtx4060');
  assert.equal(state.settings.memoryMode, 'restart');
  assert.equal(state.aceInstallation.valid, true);
  assert.match(factory.acePython(), /\.venv[\\/]Scripts[\\/]python\.exe$/);
});

test('ACE-Step auto-detection explains when the Python environment is incomplete', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-windows-ace-missing-')));
  const ace = path.join(root, 'ACE-Step-1.5');
  fs.mkdirSync(path.join(ace, 'acestep'), { recursive: true });
  fs.writeFileSync(path.join(ace, 'acestep', 'acestep_v15_pipeline.py'), '# test');
  const factory = new Factory(path.join(root, 'data'), { seedManifest: false, startHealth: false, tickMs: 1000000, platform: 'win32', aceSearchRoots: [root] });
  t.after(() => { factory.close(); fs.rmSync(root, { recursive: true, force: true }); });
  assert.equal(factory.getState().settings.acePath, '');
  assert.equal(inspectAceInstallation(ace, 'win32').hasPipeline, true);
  assert.equal(inspectAceInstallation(ace, 'win32').hasPython, false);
  await assert.rejects(factory.action('detectAce'), /готовым окружением \.venv/);
});

test('queue validation is atomic, English USA defaults and fingerprint duplicates persist', async t => {
  const { factory, reopen } = setup(t);
  await assert.rejects(factory.action('importQueue', { tracks: [{ title: 'Good', caption: 'country pop' }, { title: 'Bad' }] }), /caption/);
  assert.equal(factory.getState().tracks.length, 0);
  const queue = [{ release_title: 'Golden Signal', caption: 'original country pop', target_account: 'gleb-oxaj', lyrics: '[Instrumental]' }];
  await factory.action('importQueue', { queue });
  const second = reopen();
  assert.equal(second.getState().tracks[0].input.vocal_language, 'en');
  assert.equal(second.getState().tracks[0].accountId, 'gleb');
  assert.equal((await second.action('importQueue', { queue })).imported.length, 0);
});

test('one active job globally and FIFO account routing', async t => {
  const { factory, add } = setup(t), bos = await add(), gleb = await add('gleb', 'gleb', 2);
  await factory.action('publish', {});
  assert.equal(factory.claimJob('gleb'), null);
  const job = factory.claimJob('bos');
  assert.equal(job.handle, 'bos-423483424'); assert.equal(job.visibility, 'public'); assert.deepEqual(job.trackIds, [bos]);
  assert.equal(job.tracks[0].audioUrl, `/bridge/audio/${bos}`); assert.equal(factory.claimJob('bos'), null); assert.equal(factory.claimJob('gleb'), null);
  factory.reportJob('bos', job.id, { status: 'complete', tracks: [{ id: bos, status: 'published', publishUrl: 'https://soundcloud.com/bos-423483424/golden-song' }] });
  assert.deepEqual(factory.claimJob('gleb').trackIds, [gleb]);
});

test('cross-account IDs and permalinks reject before any partial mutation', async t => {
  const { factory, add } = setup(t), a = await add(), b = await add('bos', 'second', 2), foreign = await add('gleb', 'other', 3);
  await factory.action('publish', { trackIds: [a, b] }); const job = factory.claimJob('bos');
  assert.throws(() => factory.reportJob('gleb', job.id, { status: 'complete' }), /принадлежит/);
  assert.throws(() => factory.reportJob('bos', job.id, { status: 'complete', tracks: [{ id: a, status: 'published', publishUrl: 'https://soundcloud.com/bos-423483424/real-song' }, { id: foreign, status: 'published', publishUrl: 'https://soundcloud.com/gleb-oxaj/other' }] }), /чужой/);
  assert.equal(factory.getState().tracks.find(t => t.id === a).status, 'publish_queued');
  assert.throws(() => factory.reportJob('bos', job.id, { status: 'complete', tracks: [{ id: a, status: 'published', publishUrl: 'https://soundcloud.com/gleb-oxaj/other' }] }), /выбранного/);
  assert.throws(() => permalink('https://soundcloud.com.evil.test/bos-423483424/track', { handle: 'bos-423483424' }));
});

test('mixed final result preserves published track and marks unobserved audio uncertain', async t => {
  const { factory, add } = setup(t), a = await add(), b = await add('bos', 'second', 2);
  await factory.action('publish', {}); const job = factory.claimJob('bos');
  factory.reportJob('bos', job.id, { status: 'complete', reportId: 'final-1', tracks: [{ id: a, status: 'published', publishUrl: 'https://soundcloud.com/bos-423483424/first' }] });
  const state = factory.getState(); assert.equal(state.tracks.find(t => t.id === a).status, 'published'); assert.equal(state.tracks.find(t => t.id === b).status, 'uncertain'); assert.equal(state.jobs[0].status, 'uncertain');
  await assert.rejects(factory.action('retry', { jobId: job.id }), /Автоповтор/);
  assert.equal(factory.reportJob('bos', job.id, { status: 'complete', reportId: 'final-1' }).duplicate, true);
});

test('pre-side-effect failures may retry; checkpoints cannot be erased by safeToRetry', async t => {
  const { factory, add } = setup(t), id = await add();
  await factory.action('publish', {}); const before = factory.claimJob('bos');
  factory.reportJob('bos', before.id, { status: 'blocked', message: 'Sign in required', safeToRetry: true });
  assert.equal(factory.getState().tracks[0].status, 'ready');
  await factory.action('retry', { jobId: before.id }); const after = factory.claimJob('bos');
  factory.reportJob('bos', after.id, { status: 'progress', tracks: [{ id, status: 'uploading' }] });
  factory.reportJob('bos', after.id, { status: 'failed', safeToRetry: true, tracks: [{ id, status: 'failed' }] });
  assert.equal(factory.getState().tracks[0].status, 'uncertain'); await assert.rejects(factory.action('retry', { jobId: after.id }));
});

test('restart marks claimed jobs uncertain and pauses queued jobs without republishing', async t => {
  const { factory, add, reopen } = setup(t), a = await add(); await add('gleb', 'other', 2);
  await factory.action('publish', {}); factory.claimJob('bos');
  const restored = reopen(), state = restored.getState();
  assert.equal(state.paused, true); assert.equal(state.tracks.find(t => t.id === a).status, 'uncertain'); assert.equal(state.jobs[0].status, 'uncertain'); assert.equal(restored.claimJob('gleb'), null);
  await assert.rejects(restored.action('publish', { trackIds: [a] }));
});

test('a manually confirmed pre-upload interruption returns uncertain tracks to ready', async t => {
  const { factory, add, reopen } = setup(t), id = await add();
  await factory.action('publish', { trackIds: [id] }); factory.claimJob('bos');
  const restored = reopen();
  let state = await restored.action('markUnpublished', { trackIds: [id] });
  assert.equal(state.tracks[0].status, 'ready'); assert.equal(state.jobs[0].status, 'cancelled'); assert.equal(state.paused, false);
  const stale = restored.reportJob('bos', state.jobs[0].id, { status: 'blocked', safeToRetry: true, reportId: 'late-terminal', tracks: [] });
  assert.equal(stale.stale, true); assert.equal(restored.getState().tracks[0].status, 'ready');
  await restored.action('publish', { trackIds: [id] }); const active = restored.claimJob('bos');
  restored.reportJob('bos', active.id, { status: 'progress', tracks: [{ id, status: 'uploading' }] });
  active.lastHeartbeat = new Date(Date.now() - 130000).toISOString(); restored.state.jobs.at(-1).lastHeartbeat = active.lastHeartbeat; restored.checkLeases();
  await assert.rejects(restored.action('markUnpublished', { trackIds: [id] }), /Передача файлов уже могла начаться/);
});

test('restart resumes a queue that never reached Chrome and keeps it safe to claim', async t => {
  const { factory, add, reopen } = setup(t), id = await add();
  await factory.action('publish', { trackIds: [id] });
  const restored = reopen(), state = restored.getState();
  assert.equal(state.paused, false);
  assert.equal(state.jobs[0].status, 'queued');
  assert.equal(restored.claimJob('bos').id, state.jobs[0].id);
});

test('pause blocks next job but does not destroy active public report', async t => {
  const { factory, add } = setup(t), id = await add(); await add('rivi', 'rivi', 2);
  await factory.action('publish', {}); const job = factory.claimJob('bos'); await factory.action('pause');
  factory.reportJob('bos', job.id, { status: 'complete', tracks: [{ id, status: 'published', publishUrl: 'https://soundcloud.com/bos-423483424/track' }] });
  assert.equal(factory.claimJob('rivi'), null); await factory.action('resume'); assert.equal(factory.claimJob('rivi').accountId, 'rivi');
});

test('audio paths reject unknown IDs, changes and symlink replacement', async t => {
  const { factory, add, wav, root } = setup(t), id = await add();
  assert.throws(() => factory.audioPath('../factory-state.json'));
  const track = factory.getState().tracks[0]; fs.appendFileSync(track.path, 'tampered');
  await assert.rejects(factory.action('publish', {}), /изменился/);
  fs.unlinkSync(track.path); fs.symlinkSync(wav('replacement', 2), track.path);
  assert.throws(() => factory.audioPath(id), /перемещён/);
  const bad = path.join(root, 'fake.wav'); fs.writeFileSync(bad, Buffer.alloc(100)); assert.throws(() => audioInfo(bad), /RIFF/);
  assert.throws(() => localAceUrl('https://external.example')); assert.throws(() => localAceUrl('http://127.0.0.1:7860/path'));
});

test('portable backup copies all audio, merges without duplicate or imported jobs, rejects traversal', async t => {
  const { factory, add, root, register } = setup(t), id = await add();
  await factory.action('archive', { trackIds: [id] });
  const backup = await factory.action('exportBackup', { directory: root });
  const second = new Factory(path.join(root, 'second'), { seedManifest: false, startHealth: false, tickMs: 1000000 }); register(second);
  const imported = await second.action('importBackup', { directory: backup.directory });
  assert.equal(imported.imported, 1); assert.equal(second.getState().tracks[0].status, 'archived'); assert.equal(second.getState().jobs.length, 0); assert.equal(second.getState().paused, true);
  assert.equal((await second.action('importBackup', { file: backup.file })).skipped, 1);
  const payload = JSON.parse(fs.readFileSync(backup.file)); payload.tracks[0].path = '../bos.wav'; fs.writeFileSync(backup.file, JSON.stringify(payload));
  await assert.rejects(second.action('importBackup', { file: backup.file }), /пределы/);
});

test('monetization requires user metadata and claim carries it without automatic rights', async t => {
  const { factory, add } = setup(t), id = await add();
  await factory.action('reconcile', { trackId: id, publishUrl: 'https://soundcloud.com/bos-423483424/known-track' });
  await assert.rejects(factory.action('monetize', {}), /подтверждение прав/);
  assert.equal(factory.getState().accounts[0].rightsConfirmed, false);
  await factory.action('account', { id: 'bos', legalName: 'Example Person', mainArtist: 'Example Artist', rightsConfirmed: true, songwriterRole: 'writer' });
  await factory.action('monetize', {}); const job = factory.claimJob('bos');
  assert.equal(job.identityMode, 'paired-profile');
  assert.equal(job.tracks[0].rightsConfirmed, true); assert.equal(job.tracks[0].legalName, 'Example Person'); assert.equal(job.tracks[0].isrc, null);
});

test('full cycle scopes tracks and queues monetization only after verified public URL', async t => {
  const { factory, add } = setup(t), id = await add(); await add('rivi', 'outside', 2);
  await factory.action('account', { id: 'bos', legalName: 'Example Person', mainArtist: 'Example Artist', rightsConfirmed: true });
  await factory.action('runPipeline', { trackIds: [id], accountIds: ['bos'], monetize: true });
  assert.equal(factory.getState().pipeline.stage, 'publishing');
  const publish = factory.claimJob('bos'); factory.reportJob('bos', publish.id, { status: 'complete', tracks: [{ id, status: 'published', publishUrl: 'https://soundcloud.com/bos-423483424/complete-track' }] });
  const monetize = factory.claimJob('bos'); assert.equal(monetize.type, 'monetize'); assert.equal(monetize.tracks[0].publishUrl, 'https://soundcloud.com/bos-423483424/complete-track');
  factory.reportJob('bos', monetize.id, { status: 'complete', tracks: [{ id, status: 'submitted' }] });
  assert.equal(factory.getState().pipeline.stage, 'complete'); assert.equal(factory.getState().pipeline.active, false); assert.equal(factory.getState().tracks[1].status, 'ready');
});

test('manual finish clears a stuck pipeline and restores tracks from jobs that never started', async t => {
  const { factory, add } = setup(t), first = await add(), second = await add('bos', 'second', 2);
  await factory.action('runPipeline', { trackIds: [first, second], accountIds: ['bos'], monetize: false });
  let state = factory.getState(); assert.equal(state.pipeline.active, true); assert.equal(state.jobs[0].status, 'queued');
  state = await factory.action('finishPipeline');
  assert.equal(state.pipeline.active, false); assert.equal(state.pipeline.stage, 'cancelled'); assert.equal(state.paused, false);
  assert.equal(state.jobs[0].status, 'cancelled'); assert.ok(state.tracks.every(track => track.status === 'ready'));
  await factory.action('runPipeline', { trackIds: [first], accountIds: ['bos'], monetize: false });
  const running = factory.claimJob('bos'); assert.ok(running);
  await assert.rejects(factory.action('finishPipeline'), /выполняется/);
});

test('lease expiry prevents unsafe retries and preserves known URLs', async t => {
  const { factory, add } = setup(t), id = await add(); await factory.action('publish', {}); const job = factory.claimJob('bos');
  factory.state.jobs[0].lastHeartbeat = new Date(Date.now() - 130000).toISOString(); factory.checkLeases();
  assert.equal(factory.getState().jobs[0].status, 'uncertain'); assert.throws(() => factory.reportJob('bos', job.id, { status: 'complete' }), /соединение/);
  await factory.action('reconcile', { trackId: id, publishUrl: 'https://soundcloud.com/bos-423483424/recovered' });
  assert.equal(factory.getState().jobs[0].status, 'complete');
});

test('WAV validation rejects truncated RIFF, oversized data chunk and zero byte rate', t => {
  const { wav } = setup(t);
  const truncated = wav('truncated'); fs.truncateSync(truncated, fs.statSync(truncated).size - 10);
  assert.throws(() => audioInfo(truncated), /усечён/);
  const oversized = wav('oversized'), oversizedData = fs.readFileSync(oversized); oversizedData.writeUInt32LE(100000, 40); fs.writeFileSync(oversized, oversizedData);
  assert.throws(() => audioInfo(oversized), /усечён/);
  const invalidRate = wav('rate'), invalidData = fs.readFileSync(invalidRate); invalidData.writeUInt32LE(0, 28); fs.writeFileSync(invalidRate, invalidData);
  assert.throws(() => audioInfo(invalidRate), /равны нулю/);
});

test('titles match the 100-character browser bridge limit before generation', async t => {
  const { factory, wav } = setup(t);
  await assert.rejects(factory.action('importQueue', { tracks: [{ title: 'A'.repeat(101), caption: 'Country pop' }] }), /100/);
  await factory.action('importQueue', { tracks: [{ title: 'A'.repeat(100), caption: 'Country pop' }] });
  assert.equal(factory.getState().tracks[0].title.length, 100);
  await factory.action('importAudio', { paths: [wav('B'.repeat(110))], accountId: 'bos' });
  assert.equal(factory.getState().tracks[1].title.length, 100);
});

test('full cycle pauses with actionable error when ACE exits before readiness', async t => {
  const { factory } = setup(t);
  await factory.action('importQueue', { tracks: [{ title: 'Waiting Track', caption: 'Country pop' }] });
  factory.state.pipeline = { id: 'pipeline-test', active: true, stage: 'waiting_ace', trackIds: [factory.getState().tracks[0].id], accountIds: ['bos'], monetize: false };
  factory.state.ace = { online: false, owned: false, status: 'offline' };
  factory.advancePipeline();
  const state = factory.getState(); assert.equal(state.paused, true); assert.equal(state.pipeline.stage, 'attention'); assert.match(state.pipeline.message, /завершился до готовности/); assert.equal(state.jobs.length, 0);
});

test('backup transfers blank descriptive metadata while preserving local profiles and rights decisions', async t => {
  const { factory, root, register } = setup(t);
  await factory.action('settings', { artistName: 'Source Artist', hardware: 'rtx4060', acePath: root });
  await factory.action('account', { id: 'bos', artistName: 'Source Bos', legalName: 'Source Legal Name', mainArtist: 'Source Main Artist', rightsConfirmed: true });
  const backup = await factory.action('exportBackup', { directory: root }), json = JSON.parse(fs.readFileSync(backup.file));
  assert.equal(json.settings.artistName, 'Source Artist'); assert.equal(json.settings.acePath, undefined); assert.equal(json.settings.hardware, undefined);
  assert.equal(json.accounts[0].rightsConfirmed, undefined); assert.equal(json.accounts[0].chromeProfile, undefined); assert.equal(json.accounts[0].lastSeen, undefined);
  const destination = new Factory(path.join(root, 'other-data'), { seedManifest: false, startHealth: false, tickMs: 1000000 }); register(destination);
  await destination.action('account', { id: 'bos', artistName: '', mainArtist: 'Keep Local Name', chromeProfile: 'Profile 99' });
  const hardware = destination.getState().settings.hardware;
  // A modified backup cannot assert rights or switch the machine's browser profile.
  json.accounts[0].rightsConfirmed = true; json.accounts[0].chromeProfile = 'Profile 7'; json.settings.hardware = 'different-machine'; json.settings.acePath = '/foreign-machine/ace'; fs.writeFileSync(backup.file, JSON.stringify(json));
  await destination.action('importBackup', { file: backup.file });
  const state = destination.getState(), account = state.accounts[0];
  assert.equal(account.artistName, 'Source Bos'); assert.equal(account.legalName, 'Source Legal Name'); assert.equal(account.mainArtist, 'Keep Local Name'); assert.equal(account.chromeProfile, 'Profile 99'); assert.equal(account.rightsConfirmed, false);
  assert.equal(state.settings.artistName, 'Source Artist'); assert.equal(state.settings.hardware, hardware); assert.notEqual(state.settings.acePath, '/foreign-machine/ace');
});

test('publish snapshots album mode, default title and Amplify without observed website identity', async t => {
  const { factory, add } = setup(t), id = await add('bos', 'First Song');
  assert.equal(factory.getState().accounts[0].observedHandle, undefined);
  await factory.action('publish', { trackIds: [id] });
  const queued = factory.getState().jobs[0];
  assert.equal(queued.identityMode, 'paired-profile'); assert.equal(queued.uploadMode, 'album'); assert.equal(queued.albumTitle, 'First Song'); assert.equal(queued.amplify, true);
  const claimed = factory.claimJob('bos');
  assert.equal(claimed.identityMode, 'paired-profile'); assert.equal(claimed.uploadMode, 'album'); assert.equal(claimed.albumTitle, 'First Song'); assert.equal(claimed.amplify, true);
});

test('custom album settings stay frozen through recovery and safe retry', async t => {
  const { factory, add, reopen } = setup(t), id = await add();
  const payload = { trackIds: [id], albumTitles: { bos: 'An Exact Album' }, amplify: false };
  await factory.action('publish', payload); payload.albumTitles.bos = 'Changed After Click'; payload.amplify = true;
  factory.state.tracks[0].albumTitle = 'Later Track Metadata';
  const restored = reopen(); await restored.action('resume'); const first = restored.claimJob('bos');
  assert.equal(first.albumTitle, 'An Exact Album'); assert.equal(first.amplify, false); assert.equal(first.identityMode, 'paired-profile');
  restored.reportJob('bos', first.id, { status: 'blocked', safeToRetry: true, message: 'Form not available before upload' });
  await restored.action('retry', { jobId: first.id }); const retried = restored.claimJob('bos');
  assert.equal(retried.albumTitle, 'An Exact Album'); assert.equal(retried.amplify, false); assert.equal(retried.uploadMode, 'album'); assert.equal(retried.identityMode, 'paired-profile');
});

test('each account receives only its own album title snapshot', async t => {
  const { factory, add } = setup(t);
  const bos = await add(), gleb = await add('gleb', 'Gleb Track', 2), rivi = await add('rivi', 'Rivi Track', 3);
  const albumTitles = { bos: 'Country Collection', gleb: 'Alternative Collection', rivi: 'Soul Collection' };
  await factory.action('publish', { accountIds: ['bos', 'gleb', 'rivi'], albumTitles, amplify: true });
  albumTitles.gleb = 'Changed Input';
  const jobs = factory.getState().jobs;
  assert.deepEqual(jobs.map(job => [job.accountId, job.albumTitle, job.trackIds]), [
    ['bos', 'Country Collection', [bos]], ['gleb', 'Alternative Collection', [gleb]], ['rivi', 'Soul Collection', [rivi]],
  ]);
  assert.ok(jobs.every(job => job.amplify === true && job.identityMode === 'paired-profile' && job.uploadMode === 'album'));
  assert.equal(factory.claimJob('rivi'), null);
});

test('legacy queued jobs and legacy safe retries receive album defaults', async t => {
  const { factory, add } = setup(t); await add('bos', 'Legacy Song'); await factory.action('publish', {});
  const legacy = factory.state.jobs[0];
  for (const key of ['albumTitle', 'amplify', 'uploadMode', 'identityMode']) delete legacy[key];
  const first = factory.claimJob('bos'); assert.equal(first.albumTitle, 'Legacy Song'); assert.equal(first.amplify, true); assert.equal(first.identityMode, 'paired-profile');
  factory.reportJob('bos', first.id, { status: 'blocked', safeToRetry: true });
  for (const key of ['albumTitle', 'amplify', 'uploadMode', 'identityMode']) delete legacy[key];
  await factory.action('retry', { jobId: legacy.id });
  const retried = factory.claimJob('bos'); assert.equal(retried.albumTitle, 'Legacy Song'); assert.equal(retried.amplify, true); assert.equal(retried.uploadMode, 'album');
});

test('per-account albums split only above 100 tracks with safe numbered titles', async t => {
  const { factory, wav } = setup(t);
  await factory.action('importAudio', { accountId: 'bos', paths: Array.from({ length: 101 }, (_, i) => wav(`Album Song ${i + 1}`, i + 1)) });
  const title = 'A'.repeat(90) + '😀' + 'B'.repeat(8);
  await factory.action('publish', { accountIds: ['bos', 'bos'], albumTitles: { bos: title }, amplify: false });
  const jobs = factory.getState().jobs;
  assert.equal(jobs.length, 2); assert.equal(jobs[0].trackIds.length, 100); assert.equal(jobs[1].trackIds.length, 1);
  assert.ok(jobs[0].albumTitle.endsWith(' · Part 1')); assert.ok(jobs[1].albumTitle.endsWith(' · Part 2'));
  for (const job of jobs) { assert.ok(job.albumTitle.length <= 100); assert.ok(job.albumTitle.isWellFormed()); assert.equal(job.amplify, false); }
});

test('invalid album metadata rejects atomically before any job is queued', async t => {
  const { factory, add } = setup(t); await add(); await add('rivi', 'Other', 2);
  for (const payload of [{ albumTitles: { bos: 'Good', rivi: ' ' } }, { albumTitles: { bos: 'A'.repeat(101) } }, { albumTitles: { bos: 'Line\nBreak' } }, { albumTitles: [] }, { amplify: 'yes' }]) {
    await assert.rejects(factory.action('publish', payload));
    assert.equal(factory.getState().jobs.length, 0); assert.ok(factory.getState().tracks.every(track => track.status === 'ready'));
  }
});

test('imported album_title is preserved and full pipeline stores explicit immutable overrides', async t => {
  const { factory, add, reopen } = setup(t);
  const imported = await factory.action('importQueue', { tracks: [{ title: 'Planned Song', caption: 'Country pop', accountId: 'bos', album_title: 'Imported Album' }] });
  assert.equal(factory.getState().tracks.find(track => track.id === imported.imported[0]).albumTitle, 'Imported Album');
  await assert.rejects(factory.action('importQueue', { tracks: [{ title: 'Bad Album', caption: 'Country pop', album_title: '' }] }));
  const ready = await add(); const payload = { trackIds: [ready], accountIds: ['bos'], albumTitles: { bos: 'Pipeline Album' }, amplify: false, monetize: false };
  await factory.action('runPipeline', payload); payload.albumTitles.bos = 'Replaced Object';
  const restored = reopen(), pipeline = restored.getState().pipeline;
  assert.equal(pipeline.albumTitles.bos, 'Pipeline Album'); assert.equal(pipeline.amplify, false); assert.equal(pipeline.identityMode, 'paired-profile'); assert.equal(pipeline.uploadMode, 'album');
  await restored.action('resume'); const job = restored.claimJob('bos'); assert.equal(job.albumTitle, 'Pipeline Album'); assert.equal(job.amplify, false);
});

test('pipeline snapshots publication settings while generation is waiting and uses them after readiness', async t => {
  const { factory, wav } = setup(t);
  const imported = await factory.action('importQueue', { tracks: [{ title: 'Waiting Song', caption: 'Country pop', accountId: 'bos', album_title: 'Queue Album' }] });
  factory.acePython = () => '/fixture-python';
  factory.checkAce = async () => {};
  factory.startAce = async () => { factory.state.ace = { online: false, owned: false, status: 'starting' }; return factory.getState(); };
  await factory.action('runPipeline', { trackIds: imported.imported, amplify: false });
  assert.equal(factory.getState().pipeline.stage, 'waiting_ace'); assert.equal(factory.getState().pipeline.albumTitles.bos, 'Queue Album');
  const track = factory.state.tracks[0]; Object.assign(track, audioInfo(wav('Finished Render')), { status: 'ready', albumTitle: 'Changed During Generation' });
  factory.state.ace.online = true; factory.advancePipeline();
  const job = factory.claimJob('bos'); assert.equal(job.albumTitle, 'Queue Album'); assert.equal(job.amplify, false); assert.equal(job.uploadMode, 'album');
});

test('ACE memory mode is validated and restart waits until the replacement service is actually ready', async t => {
  const { factory } = setup(t);
  await assert.rejects(factory.action('settings', { memoryMode: 'mystery' }), /режим памяти/);
  await factory.action('settings', { memoryMode: 'speed' }); assert.equal(factory.getState().settings.memoryMode, 'speed');
  const { EventEmitter } = require('node:events');
  const old = new EventEmitter(); old.kill = () => setImmediate(() => old.emit('exit', 0));
  factory.aceProcess = old; factory.options.aceStopMs = 20; factory.options.acePollMs = 1;
  factory.startAce = async () => { factory.aceProcess = { kill() {} }; factory.state.ace = { online: false, status: 'starting', owned: true }; return factory.getState(); };
  let checks = 0; factory.checkAce = async () => { checks++; if (checks >= 3) factory.state.ace.online = true; };
  await factory.restartAce();
  assert.equal(factory.getState().ace.online, true); assert.ok(checks >= 3);
});

test('existing Mac library migrates once to the fast ACE queue without changing the new-install default', t => {
  const { factory, reopen } = setup(t);
  assert.equal(factory.getState().settings.memoryMode, 'restart');
  factory.state.settings.memoryMode = 'restart';
  factory.state.accounts.find(account=>account.id==='gleb').handle = 'gleb-oxaj';
  delete factory.state.settings.memoryPolicyVersion;
  factory.save();
  const restored = reopen(), state = restored.getState();
  assert.equal(state.settings.memoryMode, 'speed');
  assert.equal(state.settings.memoryPolicyVersion, 1);
  assert.equal(state.accounts.find(account=>account.id==='gleb').handle, 'nn1v-680019554');
  assert(state.events.some(event=>/без перезапуска между треками/.test(event.message)));
  assert(state.events.some(event=>/SoundCloud-адрес обновлён/.test(event.message)));
});
