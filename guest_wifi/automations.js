// Home Assistant automations: create guest WiFi tokens without opening the page.
//
// The add-on connects to Home Assistant (through the Supervisor, with the add-on's own
// token) and listens for the event  guest_wifi_generate  with optional data:
//   count (1), lifetime_minutes (1440), devices (1), note, request_id
// For each one it creates the tokens on the router, then
// - updates  sensor.guest_wifi_last_token  (state = first code; attributes: codes,
//   request_id, error, ...), and
// - fires  guest_wifi_tokens_generated  (or  guest_wifi_generate_failed  with "error").
// It also keeps  sensor.guest_wifi_tokens  current (state = number of unused tokens;
// attribute "tokens" = the newest tokens with their status: unused, in_use or expired),
// refreshed every minute and after every change. The dashboard card's history reads it.
//
// The script blueprint in the repository wraps this so an automation gets the code back
// as the action's response.
//
// Who is an administrator: the page asks isAdmin(userId), answered from Home Assistant's
// user list, so only administrators can change the router connection.
//
// Token script: unless turned off, the add-on creates script.guest_wifi_generate_token if
// it does not exist. Any Home Assistant user may run a script, so this is how people who
// are not administrators generate tokens from the dashboard card.
//
// Dashboard card: unless turned off, the add-on also copies card/guest-wifi-card.js into
// Home Assistant's www folder and registers it as a dashboard resource, so the
// "Guest WiFi" card can be added to a dashboard.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = (name, fallback) => process.env[name] ?? fallback;

const HA = {
  token: env('SUPERVISOR_TOKEN', ''),
  wsUrl: env('HA_WS_URL', 'ws://supervisor/core/websocket'),
  apiUrl: env('HA_API_URL', 'http://supervisor/core/api').replace(/\/+$/, ''),
  // Safety net against a runaway automation: at most this many tokens per hour this way
  maxPerHour: Number(env('AUTOMATION_MAX_TOKENS_PER_HOUR', '60')),
};
const REQUEST_EVENT = 'guest_wifi_generate';
const DONE_EVENT = 'guest_wifi_tokens_generated';
const FAILED_EVENT = 'guest_wifi_generate_failed';
const SENSOR = 'sensor.guest_wifi_last_token';
const TOKENS_SENSOR = 'sensor.guest_wifi_tokens';
const TOKENS_KEPT = 10;                       // newest tokens published to Home Assistant
const REFRESH_MS = Number(env('TOKENS_REFRESH_SECONDS', '60')) * 1000;

const CARD = {
  source: path.join(path.dirname(fileURLToPath(import.meta.url)), 'card', 'guest-wifi-card.js'),
  // Home Assistant's configuration folder as mounted into the add-on
  configDir: env('HA_CONFIG_DIR', '/homeassistant'),
  urlPath: '/local/guest-wifi-manager/guest-wifi-card.js',
};

// Copies the card into <config>/www. Returns { ok, createdWww }.
function installCardFile() {
  const www = path.join(CARD.configDir, 'www');
  if (!fs.existsSync(CARD.configDir)) throw new Error(`Home Assistant's configuration folder is not available at ${CARD.configDir}`);
  const createdWww = !fs.existsSync(www);
  const dir = path.join(www, 'guest-wifi-manager');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(CARD.source, path.join(dir, 'guest-wifi-card.js'));
  return { createdWww };
}

const fmtCode = (c) => (/^\d{10}$/.test(String(c)) ? `${String(c).slice(0, 5)}-${String(c).slice(5)}` : String(c));
const log = (msg) => console.log(`automations: ${msg}`);

export function startAutomations({ createVouchers, listVouchers, describeError, isConfigured, voucherPrefix = 'guest-wifi', dashboardCard = true, createScript = true, adminsOnly = false, version = '0' }) {
  if (!HA.token) { log('off (not running under Home Assistant)'); return null; }

  let lastCode = 'unknown';
  const recent = [];   // [timestamp, count] of tokens made through automations in the last hour

  async function api(method, path, body) {
    const res = await fetch(`${HA.apiUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${HA.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Home Assistant ${method} ${path} -> ${res.status}`);
  }

  async function publish(result) {
    const attributes = {
      friendly_name: 'Guest WiFi last token', icon: 'mdi:wifi-star',
      request_id: result.request_id ?? null, error: result.error ?? null,
      codes: result.codes ?? [], count: result.count ?? 0,
      lifetime_minutes: result.lifetime_minutes ?? null, devices: result.devices ?? null, note: result.note ?? '',
      updated_at: new Date().toISOString(),
    };
    // Sensor first: scripts wait on its request_id, so it must be current before the event.
    await api('POST', `/states/${SENSOR}`, { state: lastCode, attributes }).catch((e) => log(e.message));
    await api('POST', `/events/${result.error ? FAILED_EVENT : DONE_EVENT}`, result).catch((e) => log(e.message));
  }

  // Publishes the newest tokens and whether each has been used. Never throws.
  let refreshing = false;
  let lastTokensJson = '';
  async function refreshTokens() {
    if (refreshing || !isConfigured()) return;
    refreshing = true;
    try {
      const { vouchers } = await listVouchers(TOKENS_KEPT);
      const tokens = vouchers.map((v) => ({
        code: fmtCode(v.code),
        status: v.expired ? 'expired' : v.activatedAt ? 'in_use' : 'unused',
        lifetime_minutes: v.timeLimitMinutes,
        devices: v.authorizedGuestLimit ?? null,
        devices_used: v.authorizedGuestCount ?? 0,
        note: String(v.name || '').replace(new RegExp(`^${voucherPrefix}\\s*`), ''),
        created_at: v.createdAt,
        first_used_at: v.activatedAt,
        expires_at: v.expiresAt,
      }));
      const json = JSON.stringify(tokens);
      if (json === lastTokensJson) return;   // nothing changed: don't fill Home Assistant's history
      const count = (s) => tokens.filter((t) => t.status === s).length;
      await api('POST', `/states/${TOKENS_SENSOR}`, {
        state: String(count('unused')),
        attributes: {
          friendly_name: 'Guest WiFi tokens', icon: 'mdi:wifi-star', unit_of_measurement: 'unused',
          tokens, unused: count('unused'), in_use: count('in_use'), expired: count('expired'),
        },
      });
      lastTokensJson = json;
    } catch (e) {
      log(`could not refresh the token list: ${e.expose ? e.message : describeError(e)}`);
    } finally {
      refreshing = false;
    }
  }
  setInterval(refreshTokens, REFRESH_MS).unref?.();

  // userId: who started the script or pressed the card's button (empty for automations)
  async function onRequest(data, userId) {
    const d = data && typeof data === 'object' ? data : {};
    const request_id = d.request_id == null ? null : String(d.request_id).slice(0, 100);
    if (adminsOnly && userId && (await isAdmin(userId)) !== true) {
      log('refused a request from a user who is not an administrator (option admins_only)');
      return publish({ request_id, error: 'Only Home Assistant administrators can generate guest WiFi tokens here' });
    }
    const count = d.count ?? 1;
    const lifetime_minutes = d.lifetime_minutes ?? 1440;
    const devices = d.devices ?? 1;
    try {
      const now = Date.now();
      while (recent.length && recent[0][0] < now - 3600e3) recent.shift();
      const used = recent.reduce((n, [, c]) => n + c, 0);
      if (used + (Number(count) || 0) > HA.maxPerHour) {
        throw Object.assign(new Error(`Automations may create at most ${HA.maxPerHour} tokens per hour`), { expose: true });
      }
      const vouchers = await createVouchers({ count, minutes: lifetime_minutes, guests: devices, note: d.note, by: 'automation' });
      recent.push([now, vouchers.length]);
      const codes = vouchers.map((v) => fmtCode(v.code));
      lastCode = codes[0] ?? lastCode;
      await publish({ request_id, code: codes[0] ?? null, codes, count: codes.length, lifetime_minutes: Number(lifetime_minutes), devices: Number(devices), note: String(d.note ?? '').slice(0, 40) });
      log(`created ${codes.length} token(s)`);
      refreshTokens();
    } catch (err) {
      const error = describeError(err);
      if (!err.expose) console.error(err.message);
      log(`request failed: ${error}`);
      await publish({ request_id, error });
    }
  }

  // Makes the card available to dashboards: file in www + a dashboard resource entry.
  let cardDone = false;
  async function installCard(call) {
    if (!dashboardCard || cardDone) return;
    try {
      const { createdWww } = installCardFile();
      const url = `${CARD.urlPath}?v=${version}`;
      const resources = await call('lovelace/resources');
      const mine = (resources || []).find((r) => String(r.url).split('?')[0] === CARD.urlPath);
      if (!mine) await call('lovelace/resources/create', { res_type: 'module', url });
      else if (mine.url !== url) await call('lovelace/resources/update', { resource_id: mine.id, url });
      cardDone = true;
      log(`dashboard card installed (${mine ? (mine.url !== url ? 'updated' : 'already registered') : 'registered'}): add the "Guest WiFi" card to a dashboard`);
      if (createdWww) log('Home Assistant only serves its www folder after a restart: restart Home Assistant once so the card can load');
    } catch (e) {
      log(`could not install the dashboard card automatically: ${e.message}. See the add-on's documentation to add it by hand`);
    }
  }

  // --- Who is an administrator -------------------------------------------------
  let currentCall = null;      // the open connection's call(), or null while disconnected
  let admins = null;           // Map of user id -> true/false, refreshed at most once a minute
  let adminsAt = 0;
  // true / false, or null when Home Assistant could not be asked
  async function isAdmin(userId) {
    if (!userId) return false;
    if (!admins || Date.now() - adminsAt > 60000) {
      if (!currentCall) return admins?.get(userId) ?? null;
      try {
        const users = await currentCall('config/auth/list');
        admins = new Map(users.map((u) => [u.id, Boolean(u.is_active !== false && (u.is_owner || (u.group_ids || []).includes('system-admin')))]));
        adminsAt = Date.now();
      } catch (e) {
        log(`could not read Home Assistant's user list: ${e.message}`);
        return admins?.get(userId) ?? null;
      }
    }
    return admins.get(userId) ?? false;
  }

  // --- Token script (lets users who are not administrators generate tokens) ---------
  const SCRIPT_ID = 'guest_wifi_generate_token';
  const SCRIPT_CONFIG = {
    alias: 'Guest WiFi: generate token',
    description: 'Creates guest WiFi tokens with the Unifi Guest Wi-Fi Voucher Generator add-on and returns them: code, codes, error. Created by the add-on.',
    icon: 'mdi:wifi-star',
    mode: 'queued',
    max: 10,
    fields: {
      count: { name: 'Number of tokens', default: 1, selector: { number: { min: 1, max: 50, mode: 'box' } } },
      lifetime_minutes: { name: 'Lifetime (minutes)', default: 1440, selector: { number: { min: 1, max: 525600, mode: 'box', unit_of_measurement: 'min' } } },
      devices: { name: 'Devices per token', default: 1, selector: { number: { min: 1, max: 10, mode: 'box' } } },
      note: { name: 'Note', selector: { text: null } },
    },
    variables: { request_id: "{{ now().timestamp() | string ~ '-' ~ range(10000, 99999) | random }}" },
    sequence: [
      { event: REQUEST_EVENT, event_data: {
        request_id: '{{ request_id }}',
        count: '{{ count | default(1) | int(1) }}',
        lifetime_minutes: '{{ lifetime_minutes | default(1440, true) | int(1440) }}',
        devices: '{{ devices | default(1) | int(1) }}',
        note: "{{ note | default('') }}",
      } },
      { wait_template: `{{ state_attr('${SENSOR}', 'request_id') == request_id }}`, timeout: { seconds: 30 }, continue_on_timeout: true },
      { variables: { result: `{% set answered = wait.completed %}{% set error = state_attr('${SENSOR}', 'error') if answered else 'The Unifi Guest Wi-Fi Voucher Generator add-on did not answer. Is it running?' %}{% set codes = (state_attr('${SENSOR}', 'codes') or []) if answered and not error else [] %}{{ {'code': codes[0] if codes else '', 'codes': codes, 'error': error or ''} }}` } },
      { stop: 'Finished', response_variable: 'result' },
    ],
  };
  let scriptDone = false;
  async function ensureScript() {
    if (!createScript || scriptDone) return;
    try {
      const headers = { Authorization: `Bearer ${HA.token}`, 'Content-Type': 'application/json' };
      const exists = await fetch(`${HA.apiUrl}/states/script.${SCRIPT_ID}`, { headers, signal: AbortSignal.timeout(10000) });
      if (exists.status === 200) { scriptDone = true; return log(`script.${SCRIPT_ID} exists: everyone can generate tokens from the dashboard card`); }
      if (exists.status !== 404) throw new Error(`Home Assistant answered ${exists.status}`);
      const res = await fetch(`${HA.apiUrl}/config/script/config/${SCRIPT_ID}`, { method: 'POST', headers, body: JSON.stringify(SCRIPT_CONFIG), signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`Home Assistant answered ${res.status} ${(await res.text()).slice(0, 200)}`);
      scriptDone = true;
      log(`created script.${SCRIPT_ID}: everyone can generate tokens from the dashboard card`);
    } catch (e) {
      log(`could not create script.${SCRIPT_ID}: ${e.message}. Without it only administrators can generate tokens from the dashboard card (see the add-on's documentation)`);
    }
  }

  let retryMs = 2000;
  function connect() {
    let ws;
    try { ws = new WebSocket(HA.wsUrl); }
    catch (e) { log(`cannot connect: ${e.message}`); return setTimeout(connect, 30000); }
    let ping;
    let nextId = 1;
    const waiting = new Map();   // id -> { resolve, reject }
    const call = (type, payload = {}) => new Promise((resolve, reject) => {
      const id = nextId++;
      waiting.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, type, ...payload }));
      setTimeout(() => { if (waiting.delete(id)) reject(new Error(`${type} timed out`)); }, 15000);
    });
    ws.addEventListener('message', (m) => {
      let msg;
      try { msg = JSON.parse(m.data); } catch { return; }
      if (msg.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: HA.token }));
      else if (msg.type === 'auth_invalid') { log(`Home Assistant refused the add-on's token: ${msg.message}`); ws.close(); }
      else if (msg.type === 'auth_ok') {
        retryMs = 2000;
        call('subscribe_events', { event_type: REQUEST_EVENT })
          .then(() => log(`listening for the ${REQUEST_EVENT} event`), (e) => log(`could not subscribe: ${e.message}`));
        currentCall = call;
        installCard(call);
        ensureScript();
        lastTokensJson = '';   // Home Assistant forgets these sensors when it restarts
        refreshTokens();
        ping = setInterval(() => { if (ws.readyState === 1) call('ping').catch(() => ws.close()); }, 30000);
      } else if ((msg.type === 'result' || msg.type === 'pong') && waiting.has(msg.id)) {
        const w = waiting.get(msg.id);
        waiting.delete(msg.id);
        if (msg.type === 'pong' || msg.success) w.resolve(msg.result);
        else w.reject(new Error(msg.error?.message || 'request failed'));
      } else if (msg.type === 'event' && msg.event?.event_type === REQUEST_EVENT) {
        onRequest(msg.event.data, msg.event.context?.user_id);
      }
    });
    ws.addEventListener('close', () => {
      clearInterval(ping);
      if (currentCall === call) currentCall = null;
      for (const w of waiting.values()) w.reject(new Error('connection closed'));
      waiting.clear();
      setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 60000);
    });
    ws.addEventListener('error', () => { /* 'close' follows and retries */ });
  }
  connect();
  return { refreshTokens, isAdmin };
}
