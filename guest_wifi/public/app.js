'use strict';

const $ = (sel) => document.querySelector(sel);
const state = { lifetimes: [], maxCount: 50, last: null };

// UniFi codes are 10 digits; show them the way the hotspot portal does: 12345-67890
const fmtCode = (c) => (/^\d{10}$/.test(String(c)) ? `${String(c).slice(0, 5)}-${String(c).slice(5)}` : String(c));
const lifetimeLabel = (min) => state.lifetimes.find((l) => l.minutes === min)?.label
  || (min % 1440 === 0 ? `${min / 1440} days` : min % 60 === 0 ? `${min / 60} hours` : `${min} min`);
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
const noteOf = (name) => (name || '').replace(/^guest-wifi\s*/, '');

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json', 'X-Requested-With': 'guest-wifi' } : {}),
      ...(method === 'DELETE' ? { 'Content-Type': 'application/json', 'X-Requested-With': 'guest-wifi' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function copy(text, msg = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(msg); }
  catch { toast('Copy failed: select the code and copy it manually'); }
}

// --- Generator ------------------------------------------------------------------
function clampCount(v) { return Math.min(Math.max(Number.parseInt(v, 10) || 1, 1), state.maxCount); }

document.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => {
  $('#count').value = clampCount(Number($('#count').value) + Number(b.dataset.step));
}));
$('#count').addEventListener('change', (e) => { e.target.value = clampCount(e.target.value); });

$('#generator').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#generate');
  const err = $('#error');
  err.hidden = true;
  btn.disabled = true;
  btn.querySelector('span').textContent = 'Generating…';
  try {
    const data = await api('POST', 'api/vouchers', {
      count: clampCount($('#count').value),
      timeLimitMinutes: Number($('#lifetime').value),
      authorizedGuestLimit: Number($('#guests').value),
      note: $('#note').value,
    });
    showResult(data.vouchers, data.lifetime, Number($('#guests').value));
    loadRecent();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.querySelector('span').textContent = 'Generate Tokens';
  }
});

function showResult(vouchers, lifetime, guests) {
  state.last = { vouchers, lifetime, guests };
  const n = vouchers.length;
  $('#result-title').textContent = `${n} Guest Token${n === 1 ? '' : 's'} Generated`;
  $('#result-sub').textContent = `Each valid for ${lifetime.label.toLowerCase()} from first use`
    + (guests > 1 ? ` · up to ${guests} devices each` : '');
  $('#tokens').replaceChildren(...vouchers.map((v) => el('li', {},
    icon('key'),
    el('span', { class: 'code' }, fmtCode(v.code)),
    el('button', { type: 'button', class: 'icon-btn', 'aria-label': `Copy ${fmtCode(v.code)}`, title: 'Copy', onclick: () => copy(fmtCode(v.code)) }, icon('copy')),
  )));
  $('#result').hidden = false;
  $('#result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$('#copy-all').addEventListener('click', () => {
  if (state.last) copy(state.last.vouchers.map((v) => fmtCode(v.code)).join('\n'), 'All tokens copied');
});

$('#download').addEventListener('click', () => {
  if (!state.last) return;
  const { vouchers, lifetime, guests } = state.last;
  const rows = [['code', 'lifetime', 'devices', 'note', 'created_at'],
    ...vouchers.map((v) => [fmtCode(v.code), lifetime.label, guests, noteOf(v.name), v.createdAt])];
  const csv = rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const a = el('a', { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: `guest-wifi-tokens-${new Date().toISOString().slice(0, 10)}.csv` });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
});

$('#print').addEventListener('click', () => {
  if (!state.last) return;
  const { vouchers, lifetime, guests } = state.last;
  $('#print-sheet').replaceChildren(...vouchers.map((v) => el('div', { class: 'ticket' },
    el('h3', {}, 'Guest WiFi'),
    el('p', {}, 'Connect to the guest network and enter this code:'),
    el('span', { class: 'code' }, fmtCode(v.code)),
    el('p', {}, `Valid for ${lifetime.label.toLowerCase()} from first use${guests > 1 ? ` · ${guests} devices` : ''}`),
  )));
  window.print();
});

// --- Recent tokens ------------------------------------------------------------------
function status(v) {
  if (v.expired) return ['expired', 'Expired'];
  if (v.activatedAt) return ['active', v.expiresAt ? `In use · ends ${fmtDate(v.expiresAt)}` : 'In use'];
  return ['unused', 'Unused'];
}

async function revoke(v) {
  if (!confirm(`Revoke token ${fmtCode(v.code)}? Guests using it will be disconnected when it is removed.`)) return;
  try { await api('DELETE', `api/vouchers/${v.id}`); toast('Token revoked'); loadRecent(); }
  catch (ex) { toast(ex.message); }
}

async function loadRecent() {
  const body = $('#recent');
  try {
    const { vouchers } = await api('GET', 'api/vouchers?limit=50');
    if (!vouchers.length) {
      body.replaceChildren(el('tr', {}, el('td', { colspan: 6, class: 'muted' }, 'No tokens yet. Generate some above.')));
      return;
    }
    body.replaceChildren(...vouchers.map((v) => {
      const [cls, label] = status(v);
      return el('tr', {},
        el('td', {}, el('span', { class: 'code' }, fmtCode(v.code))),
        el('td', {}, el('span', { class: `badge ${cls}` }, label)),
        el('td', {}, lifetimeLabel(v.timeLimitMinutes)),
        el('td', { class: 'note' }, noteOf(v.name)),
        el('td', { class: 'muted' }, fmtDate(v.createdAt)),
        el('td', {},
          el('button', { type: 'button', class: 'icon-btn danger', title: 'Revoke', 'aria-label': `Revoke ${fmtCode(v.code)}`, onclick: () => revoke(v) }, icon('trash'))),
      );
    }));
  } catch (ex) {
    body.replaceChildren(el('tr', {}, el('td', { colspan: 6, class: 'muted' }, ex.message)));
  }
}
$('#refresh').addEventListener('click', loadRecent);

// --- Router setup (Home Assistant add-on) -------------------------------------------
function showSetup(on, { first = false, routerUrl = '' } = {}) {
  $('#setup').hidden = !on;
  for (const id of ['#generator', '#recent-card']) $(id).hidden = on;
  if (on) {
    $('#result').hidden = true;
    $('#setup-title').textContent = first ? 'Connect your router' : 'Router settings';
    $('#setup-cancel').hidden = first;
    $('#router-url').value = routerUrl.replace(/^https:\/\//, '');
    $('#router-key').value = '';
    $('#router-verify').checked = Boolean(state.verifyTls);
    $('#setup-error').hidden = true;
    (routerUrl ? $('#router-key') : $('#router-url')).focus();
  }
}
$('#open-setup').addEventListener('click', () => showSetup(true, { routerUrl: state.routerUrl || '' }));
$('#setup-cancel').addEventListener('click', () => showSetup(false));
$('#setup').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#setup-save');
  const err = $('#setup-error');
  err.hidden = true;
  btn.disabled = true;
  btn.querySelector('span').textContent = 'Connecting…';
  try {
    const res = await api('POST', 'api/setup', {
      unifiUrl: $('#router-url').value.trim(), apiKey: $('#router-key').value, verifyTls: $('#router-verify').checked,
    });
    state.routerUrl = res.routerUrl;
    state.verifyTls = $('#router-verify').checked;
    showSetup(false);
    toast('Router connected');
    loadRecent();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.querySelector('span').textContent = 'Connect';
  }
});

// --- Start ------------------------------------------------------------------------
(async () => {
  try {
    const cfg = await api('GET', 'api/config');
    state.routerUrl = cfg.routerUrl || '';
    state.verifyTls = Boolean(cfg.verifyTls);
    // Set on the add-on's Configuration tab: nothing to change in the app
    $('#open-setup').hidden = Boolean(cfg.managed) || !cfg.isAdmin;
    if (cfg.optionsError) {
      $('#notice-text').textContent = cfg.optionsError;
      $('#notice').hidden = false;
      for (const id of ['#generator', '#recent-card']) $(id).hidden = true;
    } else if (cfg.needsSetup && !cfg.isAdmin) {
      // Only administrators can connect the router
      $('#notice-title').textContent = 'Not set up yet';
      $('#notice-text').textContent = 'The router is not connected yet. Ask a Home Assistant administrator to open Guest WiFi and connect it.';
      $('#notice-hint').hidden = true;
      $('#notice').hidden = false;
      for (const id of ['#generator', '#recent-card']) $(id).hidden = true;
    } else if (cfg.needsSetup) showSetup(true, { first: true });
    state.lifetimes = cfg.lifetimes;
    state.maxCount = cfg.maxCount;
    $('#count').max = cfg.maxCount;
    $('#user-email').textContent = cfg.user?.name || '';
    $('#lifetime').replaceChildren(...cfg.lifetimes.map((l) => el('option', { value: l.minutes }, l.label)));
    $('#lifetime').value = '1440';
  } catch (ex) {
    $('#error').textContent = ex.message;
    $('#error').hidden = false;
  }
  if ($('#setup').hidden && $('#notice').hidden) loadRecent();
})();
