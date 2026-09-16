'use strict';
const $ = id => document.getElementById(id);
function show(message, state = '') { $('status').textContent = message; $('status').dataset.state = state; }
async function call(type, data = {}) { const r = await chrome.runtime.sendMessage({type, ...data}); if (!r?.ok) throw new Error(r?.error || 'Расширение не отвечает.'); return r; }
async function refresh() {
  try { const r = await call('popup.status'); if (r.accountId) $('account').value = r.accountId;
    show(r.message || 'Вставь код подключения из Factory.', r.connected ? 'ok' : '');
    $('token').required = !r.accountId;
  } catch(e) { show(e.message, 'error'); }
}
$('pair').addEventListener('submit', async event => { event.preventDefault(); const button = event.submitter; button.disabled = true;
  try { await call('popup.pair', {accountId:$('account').value, token:$('token').value.trim()}); $('token').value = ''; await refresh(); }
  catch(e) { show(e.message, 'error'); } finally { button.disabled = false; }
});
$('check').addEventListener('click', async () => { try { await call('popup.check'); await refresh(); } catch(e) { show(e.message,'error'); } });
$('open').addEventListener('click', async () => {
  try { await call('popup.focus'); show('Окно Music Factory открыто.', 'ok'); }
  catch(e) { show(e.message, 'error'); }
});
$('disconnect').addEventListener('click', async () => { try { await call('popup.disconnect'); await refresh(); } catch(e) { show(e.message,'error'); } });
refresh();
