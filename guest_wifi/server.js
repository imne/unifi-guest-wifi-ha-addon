// Guest WiFi Manager: Home Assistant add-on
// Small HTTP server (no dependencies) that creates, lists and revokes UniFi hotspot
// vouchers ("guest WiFi tokens").
//
// It never handles logins itself. Home Assistant's ingress proxy sits in front: only the
// Supervisor (172.30.32.2) may connect, it adds the X-Remote-User-* headers of the
// signed-in Home Assistant user, and it shows the page in a frame on Home Assistant's
// own origin under a generated path (so the UI only uses relative URLs).
//
// The router's address and API key come from the add-on's Configuration tab
// (/data/options.json). If those are left empty, the app asks for them on first use and
// keeps them in /data/settings.json (the add-on's private, persistent folder).

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAutomations } from './automations.js';

const env = (name, fallback) => process.env[name] ?? fallback;

const config = {
  host: env('HOST', '0.0.0.0'),
  port: Number(env('PORT', '8099')),
  optionsFile: env('OPTIONS_FILE', '/data/options.json'),      // written by Home Assistant
  settingsFile: env('SETTINGS_FILE', '/data/settings.json'),   // written by the in-app setup
  // Only these addresses may connect: the Supervisor's ingress proxy. (Overridden for local testing.)
  allowedClients: env('ALLOWED_CLIENT_IPS', '172.30.32.2').split(',').map((s) => s.trim()).filter(Boolean),
  unifiSite: env('UNIFI_SITE', 'default'),          // site id or internal name
  voucherPrefix: env('VOUCHER_PREFIX', 'guest-wifi'),
  maxCount: Number(env('MAX_VOUCHERS_PER_REQUEST', '50')),
};

// Lifetimes offered in the UI (minutes). UniFi counts from the guest's first login.
const LIFETIMES = [
  { minutes: 60, label: '1 Hour' },
  { minutes: 240, label: '4 Hours' },
  { minutes: 1440, label: '1 Day' },
  { minutes: 4320, label: '3 Days' },
  { minutes: 10080, label: '1 Week' },
  { minutes: 43200, label: '30 Days' },
];

const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });

// --- Router connection (set in the app, saved to settingsFile) -------------------
const makeAgent = (verifyTls) => new https.Agent({ rejectUnauthorized: Boolean(verifyTls), keepAlive: true });

// "192.168.1.1" or "https://unifi.example:8443" -> origin, or null if it is not usable
function routerOrigin(input) {
  if (typeof input !== 'string' || !input.trim()) return null;
  const raw = input.trim();
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.protocol === 'https:' && url.hostname ? url.origin : null;
  } catch { return null; }
}

function readJsonFile(file) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}; }
  catch (e) { console.error(`Ignoring unreadable ${file}: ${e.message}`); return {}; }
}

let router = null;        // { url, key, verifyTls, agent } once known
// managed: the Configuration tab has values, so they win and the in-app setup is off.
// optionsError: what is wrong with those values, shown in the app.
let homeAssistant = null;   // set at the bottom: { refreshTokens() } when running under Home Assistant
let dashboardCard = true;   // option dashboard_card: install the dashboard card
let managed = false;
let optionsError = '';
{
  const o = readJsonFile(config.optionsFile);
  if (o.dashboard_card === false) dashboardCard = false;
  const address = String(o.router_address ?? '').trim();
  const key = String(o.api_key ?? '').trim();
  managed = Boolean(address || key);
  if (managed) {
    const origin = routerOrigin(address);
    if (!address) optionsError = 'The API key is set but the router address is empty.';
    else if (!origin) optionsError = `"${address.slice(0, 60)}" is not a usable router address. Use something like 192.168.1.1.`;
    else if (!key) optionsError = 'The router address is set but the API key is empty.';
    else router = { url: origin, key, verifyTls: Boolean(o.verify_certificate), agent: makeAgent(o.verify_certificate) };
    if (optionsError) console.error(`Configuration: ${optionsError}`);
  } else {
    const s = readJsonFile(config.settingsFile);
    if (s.unifiUrl && s.unifiApiKey) router = { url: s.unifiUrl, key: s.unifiApiKey, verifyTls: Boolean(s.verifyTls), agent: makeAgent(s.verifyTls) };
  }
}

function unifi(method, apiPath, body, conn = router) {
  if (!conn) return Promise.reject(fail(409, optionsError ? `${optionsError} Fix it on the add-on's Configuration tab.` : 'The router is not set up yet'));
  const url = new URL(`${conn.url}/proxy/network/integration${apiPath}`);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method,
      agent: conn.agent,
      timeout: 15000,
      headers: {
        'X-API-KEY': conn.key,
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { /* not JSON */ }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(json);
        const err = new Error(`UniFi ${method} ${apiPath} -> ${res.statusCode}: ${json?.message || data.slice(0, 200)}`);
        err.upstreamStatus = res.statusCode;
        reject(err);
      });
    });
    req.on('timeout', () => req.destroy(new Error('UniFi request timed out')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Resolve "default" (internal name) to the site's UUID once per router.
let siteIdPromise;
function siteId() {
  if (!siteIdPromise) {
    siteIdPromise = (async () => {
      if (/^[0-9a-f-]{36}$/i.test(config.unifiSite)) return config.unifiSite;
      const sites = await unifi('GET', '/v1/sites?limit=200');
      const site = sites.data.find((s) => s.internalReference === config.unifiSite || s.name === config.unifiSite) || (sites.data.length === 1 ? sites.data[0] : null);
      if (!site) throw new Error(`UniFi site "${config.unifiSite}" not found`);
      return site.id;
    })().catch((e) => { siteIdPromise = undefined; throw e; });
  }
  return siteIdPromise;
}

// Tries the address and key against the router; saves them only if the router accepts them.
async function saveSetup({ unifiUrl, apiKey, verifyTls }) {
  const origin = routerOrigin(unifiUrl);
  if (!origin) throw fail(400, "Enter the router's address, for example 192.168.1.1");
  const url = new URL(origin);
  if (typeof apiKey !== 'string' || apiKey.trim().length < 8 || apiKey.length > 200) throw fail(400, 'Enter the API key from the UniFi console');

  const candidate = { url: url.origin, key: apiKey.trim(), verifyTls: Boolean(verifyTls), agent: makeAgent(verifyTls) };
  try {
    const sites = await unifi('GET', '/v1/sites?limit=200', undefined, candidate);
    if (!Array.isArray(sites?.data)) throw Object.assign(new Error('unexpected answer'), { upstreamStatus: 200 });
  } catch (e) {
    candidate.agent.destroy();
    const s = e.upstreamStatus;
    throw fail(400,
      s === 401 || s === 403 ? 'The router did not accept that API key'
        : s ? `That address answered, but not like a UniFi console (HTTP ${s})`
          : /certificate|self.signed|CERT_/i.test(`${e.code} ${e.message}`) ? 'The router\'s certificate could not be verified. Turn off "Verify the router\'s certificate" if it uses the built-in self-signed one'
            : `Could not reach a router at ${url.host}`);
  }
  fs.writeFileSync(config.settingsFile, JSON.stringify({ unifiUrl: candidate.url, unifiApiKey: candidate.key, verifyTls: candidate.verifyTls }), { mode: 0o600 });
  router?.agent.destroy();
  router = candidate;
  siteIdPromise = undefined;
}

const publicVoucher = (v) => ({
  id: v.id,
  code: v.code,
  name: v.name,
  createdAt: v.createdAt,
  activatedAt: v.activatedAt ?? null,
  expiresAt: v.expiresAt ?? null,
  expired: Boolean(v.expired),
  timeLimitMinutes: v.timeLimitMinutes,
  authorizedGuestLimit: v.authorizedGuestLimit ?? null,
  authorizedGuestCount: v.authorizedGuestCount ?? 0,
});

// The newest vouchers made by this app (name starts with the prefix), newest first.
async function listVouchers(limit = 50) {
  const sid = await siteId();
  const filter = `name.like('${config.voucherPrefix}*')`;
  // Ask for as many as the router gives at once, then sort: it does not return them newest first
  const page = await unifi('GET', `/v1/sites/${sid}/hotspot/vouchers?limit=200&filter=${encodeURIComponent(filter)}`);
  const vouchers = page.data.map(publicVoucher).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  return { vouchers, totalCount: page.totalCount };
}

// Creates vouchers on the router. Used by the page and by automations; validates everything.
async function createVouchers({ count = 1, minutes, guests = 1, note = '', by }) {
  count = Number(count ?? 1);
  minutes = Number(minutes);
  guests = Number(guests ?? 1);
  const cleanNote = String(note ?? '').replace(/[^\p{L}\p{N} .,'_-]/gu, '').trim().slice(0, 40);
  if (!Number.isInteger(count) || count < 1 || count > config.maxCount) throw fail(400, `Number of tokens must be 1–${config.maxCount}`);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 525600) throw fail(400, 'Token lifetime must be 1 minute to 365 days');
  if (!Number.isInteger(guests) || guests < 1 || guests > 10) throw fail(400, 'Devices per token must be 1–10');

  const sid = await siteId();
  const name = [config.voucherPrefix, cleanNote || by].join(' ').slice(0, 80);
  const result = await unifi('POST', `/v1/sites/${sid}/hotspot/vouchers`, {
    count, name, timeLimitMinutes: minutes, authorizedGuestLimit: guests,
  });
  console.log(JSON.stringify({ event: 'vouchers.created', by, count, minutes, guests }));
  return (result.vouchers || []).map(publicVoucher);
}

// What went wrong, in words fit for the page or an automation's error message.
function describeError(err) {
  if (err.expose) return err.message;
  const s = err.upstreamStatus;
  const where = managed ? "on the add-on's Configuration tab" : 'under Router settings';
  if (/certificate|self.signed|CERT_/i.test(`${err.code} ${err.message}`)) return `The router's certificate could not be verified. Turn off certificate verification ${where}`;
  if (s === 401 || s === 403) return `The router does not accept the API key. Update it ${where}`;
  return `Could not reach the router${router ? ` at ${new URL(router.url).host}` : ''}`;
}

// --- HTTP helpers -------------------------------------------------------------
// Home Assistant frames the page on its own origin, so only same-origin framing is allowed.
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'SAMEORIGIN',
};

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  const data = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Cache-Control': 'no-store',
    ...(isJson ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
    ...headers,
  });
  res.end(data);
}

function readJson(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(fail(413, 'Body too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(fail(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function clientAllowed(req) {
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return config.allowedClients.includes(ip);
}

// The signed-in Home Assistant user, from the headers the Supervisor adds.
function currentUser(req) {
  if (!req.headers['x-remote-user-id']) return null;
  const raw = req.headers['x-remote-user-display-name'] || req.headers['x-remote-user-name'] || 'Home Assistant user';
  return { name: String(raw).replace(/[^\p{L}\p{N} .,'_@-]/gu, '').trim().slice(0, 40) || 'Home Assistant user' };
}

// State-changing requests must be same-origin JSON with our custom header, which a
// cross-site form or simple request cannot send (CSRF protection).
function isTrustedWrite(req) {
  return req.headers['x-requested-with'] === 'guest-wifi'
    && (req.headers['content-type'] || '').startsWith('application/json');
}

const pkgVersion = readJsonFile(path.join(path.dirname(fileURLToPath(import.meta.url)), 'package.json')).version || '0';

// --- Static files -------------------------------------------------------------
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const staticFiles = new Map();
for (const file of fs.readdirSync(PUBLIC_DIR)) {
  staticFiles.set(`/${file}`, { body: fs.readFileSync(path.join(PUBLIC_DIR, file)), type: MIME[path.extname(file)] || 'application/octet-stream' });
}
staticFiles.set('/', staticFiles.get('/index.html'));

// --- Routes -------------------------------------------------------------------
async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname.replace(/\/{2,}/g, '/');
  const route = `${req.method} ${pathname}`;

  if (!clientAllowed(req)) return send(res, 403, { error: 'Forbidden' });
  const user = currentUser(req);
  if (!user) return send(res, 401, { error: 'Open this page from Home Assistant' });

  if (req.method === 'GET' && staticFiles.has(pathname)) {
    const f = staticFiles.get(pathname);
    return send(res, 200, f.body, { 'Content-Type': f.type, 'Cache-Control': 'no-cache' });
  }

  if (route === 'GET /api/config') {
    // The API key is never sent back, only the router's address.
    return send(res, 200, {
      user, lifetimes: LIFETIMES, maxCount: config.maxCount, routerUrl: router?.url ?? '', verifyTls: router?.verifyTls ?? false,
      managed, optionsError, needsSetup: !router && !managed,
    });
  }

  if (route === 'POST /api/setup') {
    if (!isTrustedWrite(req)) return send(res, 403, { error: 'Forbidden' });
    if (managed) throw fail(409, "The router is set on the add-on's Configuration tab");
    await saveSetup(await readJson(req));
    console.log(JSON.stringify({ event: 'router.configured', by: user.name, url: router.url }));
    homeAssistant?.refreshTokens();
    return send(res, 200, { ok: true, routerUrl: router.url });
  }

  if (route === 'GET /api/vouchers') {
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
    const { vouchers, totalCount } = await listVouchers(limit);
    return send(res, 200, { vouchers, totalCount });
  }

  if (route === 'POST /api/vouchers') {
    if (!isTrustedWrite(req)) return send(res, 403, { error: 'Forbidden' });
    const body = await readJson(req);
    const lifetime = LIFETIMES.find((l) => l.minutes === Number(body.timeLimitMinutes));
    if (!lifetime) throw fail(400, 'Unknown token lifetime');
    const vouchers = await createVouchers({
      count: body.count, minutes: lifetime.minutes, guests: body.authorizedGuestLimit, note: body.note, by: user.name,
    });
    homeAssistant?.refreshTokens();
    return send(res, 201, { vouchers, lifetime });
  }

  const del = pathname.match(/^\/api\/vouchers\/([0-9a-f-]{36})$/i);
  if (req.method === 'DELETE' && del) {
    if (!isTrustedWrite(req)) return send(res, 403, { error: 'Forbidden' });
    const sid = await siteId();
    // Only allow deleting vouchers this app created.
    let v = null;
    try { v = await unifi('GET', `/v1/sites/${sid}/hotspot/vouchers/${del[1]}`); }
    catch (e) { if (e.upstreamStatus !== 404) throw e; }
    if (!v?.name?.startsWith(config.voucherPrefix)) return send(res, 404, { error: 'Not found' });
    await unifi('DELETE', `/v1/sites/${sid}/hotspot/vouchers/${del[1]}`);
    console.log(JSON.stringify({ event: 'voucher.deleted', by: user.name, id: del[1] }));
    homeAssistant?.refreshTokens();
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: 'Not found' });
}

http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (err.expose) return send(res, err.status, { error: err.message });
    console.error(err.message);
    send(res, 502, { error: describeError(err) });
  });
}).listen(config.port, config.host, () => {
  console.log(`guest-wifi listening on http://${config.host}:${config.port} (${router ? `router ${router.url}, from ${managed ? 'the Configuration tab' : 'in-app setup'}` : 'router not set up yet'})`);
});

// Lets Home Assistant automations create tokens (see automations.js)
homeAssistant = startAutomations({
  createVouchers, listVouchers, describeError, dashboardCard, version: pkgVersion,
  isConfigured: () => Boolean(router), voucherPrefix: config.voucherPrefix,
});
