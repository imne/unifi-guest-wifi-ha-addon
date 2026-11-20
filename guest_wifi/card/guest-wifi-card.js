// Guest WiFi card for Home Assistant dashboards (installed by the Guest WiFi Manager add-on).
// Shows the latest guest WiFi token and a button that generates a new one.
//
//   type: custom:guest-wifi-card
//   title: Guest WiFi          # optional
//   lifetime_minutes: 1440     # optional, preselected lifetime
//   devices: 1                 # optional, devices per token
//   note: Dashboard            # optional, shown next to the token in the add-on
//   script: script.guest_wifi_generate_token   # optional, see below
//   show_history: true         # optional, whether the history starts switched on
//   history_count: 5           # optional, how many tokens the history lists (1-10)
//
// The history lists the newest tokens and whether each is unused, in use or expired. The
// "History" switch on the card turns it on or off; each browser remembers its choice.
//
// Without "script" the card asks the add-on directly, which Home Assistant only allows
// for administrators. With "script" (the blueprint script from the add-on's repository)
// any user who may run that script can generate tokens.

const SENSOR = 'sensor.guest_wifi_last_token';
const TOKENS_SENSOR = 'sensor.guest_wifi_tokens';
const EVENT = 'guest_wifi_generate';
const STATUS = { unused: 'Unused', in_use: 'In use', expired: 'Expired' };
const LIFETIMES = [[60, '1 hour'], [240, '4 hours'], [1440, '1 day'], [4320, '3 days'], [10080, '1 week'], [43200, '30 days']];
const lifetimeLabel = (min) => (LIFETIMES.find(([m]) => m === Number(min)) || [0, `${min} min`])[1];

class GuestWifiCard extends HTMLElement {
  static getStubConfig() { return { title: 'Guest WiFi', lifetime_minutes: 1440 }; }

  static getConfigForm() {
    return {
      schema: [
        { name: 'title', selector: { text: {} } },
        { name: 'lifetime_minutes', selector: { select: { mode: 'dropdown', options: LIFETIMES.map(([m, l]) => ({ value: String(m), label: l })) } } },
        { name: 'devices', selector: { number: { min: 1, max: 10, mode: 'box' } } },
        { name: 'note', selector: { text: {} } },
        { name: 'script', selector: { entity: { domain: 'script' } } },
        { name: 'show_history', selector: { boolean: {} } },
        { name: 'history_count', selector: { number: { min: 1, max: 10, mode: 'box' } } },
      ],
      computeLabel: (s) => ({ title: 'Title', lifetime_minutes: 'Default lifetime', devices: 'Devices per token', note: 'Note', script: 'Script (lets non-administrators generate)', show_history: 'History switched on to start with', history_count: 'Tokens in the history' }[s.name]),
    };
  }

  setConfig(config) {
    this._config = { title: 'Guest WiFi', devices: 1, note: 'Dashboard', show_history: true, history_count: 5, ...config };
    // The on-card switch wins over the configured default, remembered per browser and card title
    this._historyKey = `guest-wifi-card:history:${this._config.title}`;
    let saved = null;
    try { saved = localStorage.getItem(this._historyKey); } catch { /* storage blocked */ }
    this._showHistory = saved === null ? this._config.show_history !== false : saved === 'on';
    this._tokensJson = null;
    this._lifetime = Number(this._config.lifetime_minutes) || 1440;
    this._busy = false;
    this._error = '';
    this._pending = null;
    this._build();
    this._update();
  }

  set hass(hass) {
    this._hass = hass;
    const s = hass.states[SENSOR];
    // The add-on answers through the sensor, tagged with our request id
    if (this._pending && s && s.attributes.request_id === this._pending) this._finish(s.attributes.error || '');
    this._update();
  }

  getCardSize() { return this._showHistory ? 6 : 3; }
  getGridOptions() { return { columns: 6, min_columns: 4, min_rows: 3 }; }

  _build() {
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
    this.shadowRoot.innerHTML = `
      <style>
        [hidden] { display: none !important; }
        ha-card { padding: 16px; display: flex; flex-direction: column; gap: 12px; height: 100%; box-sizing: border-box; }
        .head { display: flex; align-items: center; gap: 10px; font-size: 1.1em; font-weight: 500; }
        .head #title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .toggle { display: flex; align-items: center; gap: 6px; font-size: .8em; font-weight: 400; color: var(--secondary-text-color); cursor: pointer; }
        .toggle input { width: 16px; height: 16px; margin: 0; accent-color: var(--primary-color); cursor: pointer; }
        .history { border-top: 1px solid var(--divider-color); padding-top: 8px; display: flex; flex-direction: column; }
        .history .empty { color: var(--secondary-text-color); font-size: .9em; text-align: center; padding: 6px 0; }
        .item { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 4px 10px; padding: 7px 0; }
        .item + .item { border-top: 1px solid var(--divider-color); }
        .item .c { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-weight: 600; letter-spacing: .04em; user-select: all; }
        .item .meta { color: var(--secondary-text-color); font-size: .8em; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .badge { padding: 2px 9px; border-radius: 999px; font-size: .75em; font-weight: 600; white-space: nowrap; }
        .badge.unused { background: color-mix(in srgb, var(--primary-color) 18%, transparent); color: var(--primary-color); }
        .badge.in_use { background: color-mix(in srgb, var(--success-color, #43a047) 20%, transparent); color: var(--success-color, #43a047); }
        .badge.expired { background: color-mix(in srgb, var(--secondary-text-color) 18%, transparent); color: var(--secondary-text-color); }
        .head ha-icon { color: var(--primary-color); }
        .code { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 2em; font-weight: 600; letter-spacing: .06em; text-align: center; padding: 6px 0 0; user-select: all; }
        .code.empty { font-size: 1em; font-weight: 400; letter-spacing: 0; color: var(--secondary-text-color); font-family: inherit; }
        .sub { text-align: center; color: var(--secondary-text-color); font-size: .9em; min-height: 1.2em; }
        .error { color: var(--error-color); text-align: center; font-size: .9em; }
        .row { display: flex; gap: 8px; margin-top: auto; }
        select, button { font: inherit; height: 40px; border-radius: 8px; border: 1px solid var(--divider-color); background: var(--card-background-color); color: var(--primary-text-color); padding: 0 10px; }
        select { flex: 1; min-width: 0; }
        button { cursor: pointer; }
        button.primary { flex: 1.4; background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: var(--primary-color); font-weight: 500; }
        button[disabled] { opacity: .6; cursor: progress; }
      </style>
      <ha-card>
        <div class="head"><ha-icon icon="mdi:wifi-star"></ha-icon><span id="title"></span>
          <label class="toggle" title="Show or hide the token history"><input type="checkbox" id="history-toggle" role="switch">History</label></div>
        <div class="code" id="code"></div>
        <div class="sub" id="sub"></div>
        <div class="error" id="error" hidden></div>
        <div class="row">
          <select id="lifetime" aria-label="Token lifetime"></select>
          <button id="copy" title="Copy the token">Copy</button>
          <button id="generate" class="primary">New token</button>
        </div>
        <div class="history" id="history" hidden></div>
      </ha-card>`;
    const $ = (id) => this.shadowRoot.getElementById(id);
    $('title').textContent = this._config.title;
    for (const [m, l] of LIFETIMES) $('lifetime').add(new Option(l, m));
    if (!LIFETIMES.some(([m]) => m === this._lifetime)) $('lifetime').add(new Option(`${this._lifetime} min`, this._lifetime));
    $('lifetime').value = String(this._lifetime);
    $('lifetime').addEventListener('change', (e) => { this._lifetime = Number(e.target.value); });
    $('generate').addEventListener('click', () => this._generate());
    $('copy').addEventListener('click', () => this._copy());
    $('history-toggle').checked = this._showHistory;
    $('history-toggle').addEventListener('change', (e) => {
      this._showHistory = e.target.checked;
      try { localStorage.setItem(this._historyKey, this._showHistory ? 'on' : 'off'); } catch { /* storage blocked */ }
      this._tokensJson = null;
      this._update();
    });
  }

  _update() {
    if (!this.shadowRoot || !this._hass) return;
    const $ = (id) => this.shadowRoot.getElementById(id);
    const s = this._hass.states[SENSOR];
    const code = s && !['unknown', 'unavailable', ''].includes(s.state) ? s.state : '';
    $('code').textContent = code || 'No token yet';
    $('code').classList.toggle('empty', !code);
    const a = s ? s.attributes : {};
    $('sub').textContent = code && a.lifetime_minutes
      ? `Valid for ${lifetimeLabel(a.lifetime_minutes)} from first use${a.count > 1 ? ` · ${a.count} tokens made` : ''}` : '';
    $('copy').hidden = !code;
    $('error').textContent = this._error;
    $('error').hidden = !this._error;
    $('generate').disabled = this._busy;
    $('generate').textContent = this._busy ? 'Generating…' : 'New token';
    this._renderHistory();
  }

  _renderHistory() {
    const box = this.shadowRoot.getElementById('history');
    box.hidden = !this._showHistory;
    if (!this._showHistory) return;
    const t = this._hass.states[TOKENS_SENSOR];
    const count = Math.min(Math.max(Number(this._config.history_count) || 5, 1), 10);
    const tokens = t && Array.isArray(t.attributes.tokens) ? t.attributes.tokens.slice(0, count) : null;
    const json = JSON.stringify(tokens);
    if (json === this._tokensJson) return;   // unchanged: keep the DOM (and any text selection)
    this._tokensJson = json;
    box.replaceChildren();
    if (!tokens || !tokens.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = tokens ? 'No tokens yet' : 'History is not available yet. Is the add-on running?';
      return box.append(empty);
    }
    for (const tok of tokens) {
      const row = document.createElement('div');
      row.className = 'item';
      const code = document.createElement('span');
      code.className = 'c';
      code.textContent = tok.code;
      const meta = document.createElement('span');
      meta.className = 'meta';
      const when = tok.status === 'in_use' && tok.expires_at ? `until ${this._when(tok.expires_at)}` : `made ${this._when(tok.created_at)}`;
      meta.textContent = [lifetimeLabel(tok.lifetime_minutes), when, tok.note].filter(Boolean).join(' · ');
      meta.title = meta.textContent;
      const badge = document.createElement('span');
      badge.className = `badge ${STATUS[tok.status] ? tok.status : 'unused'}`;
      badge.textContent = STATUS[tok.status] || tok.status;
      row.append(code, meta, badge);
      box.append(row);
    }
  }

  _when(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const lang = (this._hass && this._hass.locale && this._hass.locale.language) || undefined;
    return d.toLocaleString(lang, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  _finish(error) {
    clearTimeout(this._timer);
    this._pending = null;
    this._busy = false;
    this._error = error;
    this._update();
  }

  async _generate() {
    if (this._busy || !this._hass) return;
    this._busy = true;
    this._error = '';
    this._update();
    const data = { count: 1, lifetime_minutes: this._lifetime, devices: Number(this._config.devices) || 1, note: this._config.note || '' };
    try {
      if (this._config.script) {
        const res = await this._hass.callService('script', String(this._config.script).replace(/^script\./, ''), data, undefined, false, true);
        this._finish((res && res.response && res.response.error) || '');
      } else {
        this._pending = `card-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        this._timer = setTimeout(() => this._finish('The Guest WiFi Manager add-on did not answer. Is it running?'), 30000);
        await this._hass.callApi('POST', `events/${EVENT}`, { ...data, request_id: this._pending });
      }
    } catch (err) {
      const unauthorized = err && (err.status_code === 401 || err.code === 'unauthorized' || /unauthor/i.test(String(err.message || err.body?.message || '')));
      this._finish(unauthorized
        ? 'Only administrators can generate tokens from this card. Ask an administrator to set "script" in the card\'s settings.'
        : `Could not generate a token: ${err && (err.message || err.body?.message) || 'unknown error'}`);
    }
  }

  async _copy() {
    const code = this.shadowRoot.getElementById('code').textContent;
    const btn = this.shadowRoot.getElementById('copy');
    try { await navigator.clipboard.writeText(code); btn.textContent = 'Copied'; }
    catch {
      // No clipboard access (plain http): select the code so it can be copied by hand
      const sel = this.shadowRoot.getSelection ? this.shadowRoot.getSelection() : window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(this.shadowRoot.getElementById('code'));
      sel.removeAllRanges(); sel.addRange(range);
      btn.textContent = 'Selected';
    }
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  }
}

if (!customElements.get('guest-wifi-card')) customElements.define('guest-wifi-card', GuestWifiCard);
window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === 'guest-wifi-card')) {
  window.customCards.push({ type: 'guest-wifi-card', name: 'Guest WiFi', description: 'Shows the latest guest WiFi token and generates new ones (Guest WiFi Manager add-on).', preview: true });
}
