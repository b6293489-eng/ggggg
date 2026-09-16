/* Shared, dependency-free validation. No SoundCloud credentials are read. */
(function (root) {
  'use strict';
  const ACCOUNTS = ['bos', 'gleb', 'rivi'];
  const terminal = new Set(['published', 'submitted', 'monetizing', 'rejected']);
  const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
  function trackUrl(value, handle) {
    try {
      const url = new URL(value, 'https://soundcloud.com');
      const parts = url.pathname.split('/').filter(Boolean);
      if (url.protocol !== 'https:' || url.hostname !== 'soundcloud.com' || parts.length !== 2 ||
          parts[0].toLowerCase() !== handle.toLowerCase() || url.searchParams.has('secret_token') ||
          ['tracks', 'albums', 'sets', 'reposts', 'popular-tracks', 'likes'].includes(parts[1])) return null;
      return `https://soundcloud.com/${parts[0]}/${parts[1]}`;
    } catch (_) { return null; }
  }
  function profileHandle(value) {
    try {
      const url = new URL(value, 'https://soundcloud.com');
      const parts = url.pathname.split('/').filter(Boolean);
      if (url.protocol !== 'https:' || url.hostname !== 'soundcloud.com' || parts.length !== 1 ||
          ['you', 'upload', 'stream', 'discover', 'search', 'signin', 'settings', 'pages'].includes(parts[0])) return null;
      return parts[0].toLowerCase();
    } catch (_) { return null; }
  }
  function validateConfig(input) {
    if (!ACCOUNTS.includes(input.accountId)) throw new Error('Выбери Бос, Gleb fps или Rivi.');
    if (!/^[A-Za-z0-9_-]{16,256}$/.test(input.token || '')) throw new Error('Вставь код подключения из Factory.');
    return {accountId: input.accountId, token: input.token, port: 8788};
  }
  function validateJob(job, config) {
    if (!job || typeof job.id !== 'string' || !job.id || job.accountId !== config.accountId ||
        !['publish', 'monetize'].includes(job.type) || !/^[\w-]+$/.test(job.handle || '') ||
        !Array.isArray(job.tracks) || !job.tracks.length || job.tracks.length > 100) {
      throw new Error('Factory передала некорректное задание.');
    }
    if (job.identityMode !== undefined && !['paired-profile', 'verify-dom'].includes(job.identityMode)) throw new Error('Неизвестный режим аккаунта.');
    if (job.type === 'publish' && job.uploadMode === 'album') {
      if (!normalize(job.albumTitle) || normalize(job.albumTitle).length > 100) throw new Error('Укажи название альбома: от 1 до 100 символов.');
      if (job.amplify !== undefined && typeof job.amplify !== 'boolean') throw new Error('Некорректная настройка Amplify.');
    }
    const ids = new Set(), titles = new Set();
    for (const t of job.tracks) {
      if (!t.id || typeof t.id !== 'string' || ids.has(t.id) || !normalize(t.title) ||
          normalize(t.title).length > 100 || titles.has(normalize(t.title).toLowerCase())) {
        throw new Error('Названия и ID треков должны быть непустыми и уникальными в пачке.');
      }
      if (job.type === 'monetize' && !trackUrl(t.publishUrl, job.handle)) {
        throw new Error(`Нет подтверждённой ссылки публикации: ${t.title}`);
      }
      ids.add(t.id); titles.add(normalize(t.title).toLowerCase());
    }
    return job;
  }
  function monetizationMetadata(job, track) {
    const a = job.account || {}, m = {...a, ...(track.monetization || {})};
    const rightsConfirmed = track.rightsConfirmed ?? m.rightsConfirmed;
    const contentRating = track.contentRating || m.contentRating ||
      (typeof track.explicit === 'boolean' ? (track.explicit ? 'Explicit' : 'Not Explicit') : null);
    const legalName = normalize(m.legalName), mainArtist = normalize(m.mainArtist || job.artistName);
    const songwriterRole = m.songwriterRole;
    if (rightsConfirmed !== true || !legalName || !mainArtist ||
        !['writer', 'representative'].includes(songwriterRole) ||
        !['Not Explicit', 'Explicit', 'Clean Edit'].includes(contentRating) ||
        !(Object.prototype.hasOwnProperty.call(track, 'isrc') || Object.prototype.hasOwnProperty.call(m, 'isrc'))) {
      throw new Error(`Для «${track.title}» нужны подтверждение прав, автор/представитель, юридическое имя, артист, рейтинг и ISRC (либо «нет»).`);
    }
    const isrc = Object.prototype.hasOwnProperty.call(track, 'isrc') ? track.isrc : m.isrc;
    if (isrc !== null && !/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(isrc || '')) throw new Error(`Некорректный ISRC: ${track.title}`);
    return {rightsConfirmed, legalName, mainArtist, songwriterRole, contentRating, isrc};
  }
  function outputName(track) {
    const title = normalize(track.title).replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/, '');
    const ext = String(track.filename || '').match(/\.(wav|mp3|flac|aiff|aif|ogg|m4a)$/i)?.[1] || 'wav';
    return `${title}.${ext.toLowerCase()}`;
  }
  function verifiedResults(job, links) {
    return job.tracks.flatMap(t => {
      const urls = [...new Set(links.filter(l => normalize(l.title).toLowerCase() === normalize(t.title).toLowerCase())
        .map(l => trackUrl(l.url, job.handle)).filter(Boolean))];
      return urls.length === 1 ? [{id: t.id, status: 'published', publishUrl: urls[0]}] : [];
    });
  }
  function afterSideEffect(tracks) {
    return tracks.map(t => terminal.has(t.status) ? t : {...t, status: 'uncertain'});
  }
  root.FactoryBridge = {ACCOUNTS, terminal, normalize, trackUrl, profileHandle, validateConfig, validateJob,
    monetizationMetadata, outputName, verifiedResults, afterSideEffect};
  if (typeof module !== 'undefined') module.exports = root.FactoryBridge;
})(globalThis);
