'use strict';
// Isolated real-render smoke test; never touches the user's Factory library.
const fs = require('node:fs');
const path = require('node:path');
const { Factory, audioInfo } = require('../core/index.cjs');

process.env.HF_HUB_OFFLINE = '1';
process.env.TRANSFORMERS_OFFLINE = '1';
process.env.HF_DATASETS_OFFLINE = '1';
const workspace = path.resolve(__dirname, '../../..');
const data = path.resolve(process.argv[2] || path.join(workspace, 'work/generation-smoke'));
const acePath = process.argv[3] || '/Users/hlibokhai/Documents/Codex/ACE-Step-1.5';
let last = '', closed = false;
const factory = new Factory(data, {
  seedManifest: false, startHealth: false,
  onEvent(state) {
    const current = JSON.stringify({ ace: state.ace.status, paused: state.paused, jobs: state.jobs.map(j => ({ id: j.id, status: j.status, message: j.message })) });
    if (current !== last) { last = current; process.stdout.write(current + '\n'); }
  },
});
function close() { if (!closed) { closed = true; factory.close(); } }
process.once('SIGINT', () => { close(); process.exit(130); });
process.once('SIGTERM', () => { close(); process.exit(143); });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  if (factory.getState().tracks.length) throw new Error('Smoke data directory already has tracks; supply a new isolated directory.');
  for (const folder of ['acestep-v15-turbo', 'vae', 'Qwen3-Embedding-0.6B']) {
    const modelDir = path.join(acePath, 'checkpoints', folder);
    if (!fs.existsSync(modelDir) || !fs.readdirSync(modelDir).some(name => /\.(safetensors|bin)$/.test(name))) throw new Error(`Missing local model weights: ${modelDir}. No downloads allowed.`);
  }
  await factory.action('settings', { acePath, aceUrl: 'http://127.0.0.1:7860', hardware: process.platform === 'darwin' ? 'mac' : 'rtx4060' });
  await factory.action('startAce');
  const bootDeadline = Date.now() + 10 * 60 * 1000;
  while (!factory.getState().ace.online) {
    if (Date.now() > bootDeadline) throw new Error('ACE-Step readiness timed out after 10 minutes.');
    if (!factory.aceProcess && factory.getState().ace.status === 'offline') throw new Error('ACE-Step exited before readiness. Inspect logs/ace-step.log.');
    await delay(2500); await factory.action('checkAce');
  }
  const imported = await factory.action('importQueue', { tracks: [{
    title: 'Factory Smoke — Golden Highway', accountId: 'bos',
    caption: 'Original instrumental American country pop, warm clean electric guitar, bright acoustic rhythm, relaxed tight drums, hopeful summer road trip mood, no vocals, no speech',
    lyrics: '[Instrumental]', bpm: 108, key_scale: 'C major', time_signature: '4', vocal_language: 'unknown', duration: 10,
  }] });
  await factory.action('generate', { trackIds: imported.imported });
  const renderDeadline = Date.now() + 15 * 60 * 1000;
  for (;;) {
    const state = factory.getState(), track = state.tracks.find(t => t.id === imported.imported[0]);
    if (track.status === 'ready') {
      const info = audioInfo(factory.audioPath(track.id));
      if (!(info.duration >= 9 && info.duration <= 12)) throw new Error(`Unexpected generated duration: ${info.duration}`);
      process.stdout.write(JSON.stringify({ result: 'PASS', trackId: track.id, title: track.title, ...info }) + '\n'); return;
    }
    if (track.status === 'generation_failed') throw new Error(track.message);
    if (Date.now() > renderDeadline) throw new Error('Render timed out after 15 minutes.');
    await delay(2500);
  }
}
main().catch(error => { process.stderr.write(JSON.stringify({ result: 'FAIL', message: error.message, data }) + '\n'); process.exitCode = 1; }).finally(close);
