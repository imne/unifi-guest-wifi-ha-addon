// Guest WiFi card for Home Assistant dashboards (installed by the Guest WiFi Manager add-on).
// Shows the latest guest WiFi token and a button that generates a new one.
//
//   type: custom:guest-wifi-card
//   title: Guest WiFi          # optional
//   lifetime_minutes: 1440     # optional, preselected lifetime
//   devices: 1                 # optional, devices per token
//   note: Dashboard            # optional, shown next to the token in the add-on
//   script: script.guest_wifi_generate_token   # optional, see below
//
// Without "script" the card asks the add-on directly, which Home Assistant only allows
// for administrators. With "script" (the blueprint script from the add-on's repository)
// any user who may run that script can generate tokens.

const SENSOR = 'sensor.guest_wifi_last_token';
const EVENT = 'guest_wifi_generate';
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
      ],
      computeLabel: (s) => ({ title: 'Title', lifetime_minutes: 'Default lifetime', devices: 'Devices per token', note: 'Note', script: 'Script (lets non-administrators generate)' }[s.name]),
    };
  }

  setConfig(config) {
    this._config = { title: 'Guest WiFi', devices: 1, note: 'Dashboard', ...config };
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

  getCardSize() { return 3; }
  getGridOptions() { return { columns: 6, rows: 3, min_columns: 4, min_rows: 3 }; }

  _build() {
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
    this.shadowRoot.innerHTML = `
      <style>
        ha-card { padding: 16px; display: flex; flex-direction: column; gap: 12px; height: 100%; box-sizing: border-box; }
        .head { display: flex; align-items: center; gap: 10px; font-size: 1.1em; font-weight: 500; }
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
        <div class="head"><ha-icon icon="mdi:wifi-star"></ha-icon><span id="title"></span></div>
        <div class="code" id="code"></div>
        <div class="sub" id="sub"></div>
        <div class="error" id="error" hidden></div>
        <div class="row">
          <select id="lifetime" aria-label="Token lifetime"></select>
          <button id="copy" title="Copy the token">Copy</button>
          <button id="generate" class="primary">New token</button>
        </div>
      </ha-card>`;
    const $ = (id) => this.shadowRoot.getElementById(id);
    $('title').textContent = this._config.title;
    for (const [m, l] of LIFETIMES) $('lifetime').add(new Option(l, m));
    if (!LIFETIMES.some(([m]) => m === this._lifetime)) $('lifetime').add(new Option(`${this._lifetime} min`, this._lifetime));
    $('lifetime').value = String(this._lifetime);
    $('lifetime').addEventListener('change', (e) => { this._lifetime = Number(e.target.value); });
    $('generate').addEventListener('click', () => this._generate());
    $('copy').addEventListener('click', () => this._copy());
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
  window.customCards.push({ type: 'guest-wifi-card', name: 'Guest WiFi', description: 'Shows the latest guest WiFi token and generates new ones (Guest WiFi Manager add-on).', preview: false });
}
