// Home Assistant automations: create guest WiFi tokens without opening the page.
//
// The add-on connects to Home Assistant (through the Supervisor, with the add-on's own
// token) and listens for the event  guest_wifi_generate  with optional data:
//   count (1), lifetime_minutes (1440), devices (1), note, request_id
// For each one it creates the tokens on the router, then
// - updates  sensor.guest_wifi_last_token  (state = first code; attributes: codes,
//   request_id, error, ...), and
// - fires  guest_wifi_tokens_generated  (or  guest_wifi_generate_failed  with "error").
// The script blueprint in the repository wraps this so an automation gets the code back
// as the action's response.

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

const fmtCode = (c) => (/^\d{10}$/.test(String(c)) ? `${String(c).slice(0, 5)}-${String(c).slice(5)}` : String(c));
const log = (msg) => console.log(`automations: ${msg}`);

export function startAutomations({ createVouchers, describeError }) {
  if (!HA.token) { log('off (not running under Home Assistant)'); return; }

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

  async function onRequest(data) {
    const d = data && typeof data === 'object' ? data : {};
    const request_id = d.request_id == null ? null : String(d.request_id).slice(0, 100);
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
    } catch (err) {
      const error = describeError(err);
      if (!err.expose) console.error(err.message);
      log(`request failed: ${error}`);
      await publish({ request_id, error });
    }
  }

  let retryMs = 2000;
  function connect() {
    let ws;
    try { ws = new WebSocket(HA.wsUrl); }
    catch (e) { log(`cannot connect: ${e.message}`); return setTimeout(connect, 30000); }
    let ping;
    ws.addEventListener('message', (m) => {
      let msg;
      try { msg = JSON.parse(m.data); } catch { return; }
      if (msg.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: HA.token }));
      else if (msg.type === 'auth_invalid') { log(`Home Assistant refused the add-on's token: ${msg.message}`); ws.close(); }
      else if (msg.type === 'auth_ok') {
        retryMs = 2000;
        ws.send(JSON.stringify({ id: 1, type: 'subscribe_events', event_type: REQUEST_EVENT }));
        let id = 2;
        ping = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ id: id++, type: 'ping' })); }, 30000);
      } else if (msg.type === 'result' && msg.id === 1) {
        log(msg.success ? `listening for the ${REQUEST_EVENT} event` : `could not subscribe: ${msg.error?.message}`);
      } else if (msg.type === 'event' && msg.event?.event_type === REQUEST_EVENT) {
        onRequest(msg.event.data);
      }
    });
    ws.addEventListener('close', () => {
      clearInterval(ping);
      setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 60000);
    });
    ws.addEventListener('error', () => { /* 'close' follows and retries */ });
  }
  connect();
}
