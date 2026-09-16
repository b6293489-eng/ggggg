'use strict';
const path = require('node:path');

const internalTitle = value => !String(value || '').trim() || /^(?:track[_-])?[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}(?:\.[a-z0-9]+)?$/i.test(String(value).trim()) || /^track_[a-f\d]{8}(?:-|$)/i.test(String(value).trim());
function metadata(value) {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return {}; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function resolveTrackTitle(record) {
  const nested = [metadata(record.album_data), metadata(record.metadata), metadata(record.input), metadata(record.generation)];
  const candidates = [record.title, record.release_title, record.track_title, ...nested.flatMap(item => [item.release_title, item.track_title, item.title]), record.output_name];
  return candidates.find(value => typeof value === 'string' && !internalTitle(value) && value.trim() !== record.id)?.trim() || '';
}
function requireTrackTitle(record) {
  const title = resolveTrackTitle(record);
  if (!title || title.length > 100 || /[\x00-\x1f\x7f]/.test(title)) throw new Error(`У трека ${record.id || ''} нет корректного названия. Импортируй JSON с title / release_title или исправь название в библиотеке. Внутренний ID не будет опубликован.`);
  return title;
}
function normalizeQueue(queue) {
  if (Array.isArray(queue)) return queue;
  const album = metadata(queue?.album_data);
  const items = queue?.tracks || album.tracks || (Array.isArray(queue?.album_data) ? queue.album_data : null);
  if (!Array.isArray(items)) return queue;
  return items.map(item => ({ ...item, album_title: item.album_title ?? album.album_title ?? queue.album_title, target_account: item.target_account ?? album.target_account ?? queue.target_account }));
}
function uploadFilename(title, extension = '.wav') {
  let stem = requireTrackTitle({ title }).normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(stem)) stem = '_' + stem;
  if (!stem) throw new Error('Не удалось подготовить имя аудиофайла.');
  if (!/^\.(wav|mp3|flac|aif|aiff|ogg|m4a)$/i.test(extension)) throw new Error('Неподдерживаемое расширение аудио.');
  return stem + extension.toLowerCase();
}
function publicationTracks(tracks) {
  const titles = new Set(), files = new Set();
  return tracks.map(track => {
    const title = requireTrackTitle(track), filename = uploadFilename(title, path.extname(track.path || track.filename || '.wav'));
    const key = title.normalize('NFC').toLocaleLowerCase('en-US');
    if (titles.has(key) || files.has(filename.toLocaleLowerCase('en-US'))) throw new Error(`В одной пачке совпадают названия или имена файлов: «${title}». Уточни названия, чтобы не перепутать ссылки на треки.`);
    titles.add(key); files.add(filename.toLocaleLowerCase('en-US'));
    return { ...track, title, filename };
  });
}
module.exports = { internalTitle, resolveTrackTitle, requireTrackTitle, normalizeQueue, uploadFilename, publicationTracks };
