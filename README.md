# Guest WiFi Manager: Home Assistant add-on

Generate guest WiFi tokens (UniFi hotspot vouchers) from the Home Assistant sidebar.

- Pick how many tokens and how long each lasts (1 hour to 30 days, counted from the guest's
  first login), optionally how many devices per token and a note.
- Copy one or all codes, download a CSV, or print cut-out cards for guests.
- See recent tokens (unused / in use / expired) and revoke any of them.
- **Automations**: a script blueprint creates tokens and returns the code to your
  automation (send it in a notification, show it on a display, ...).
- **Dashboard card**: shows the latest token, makes a new one with one tap, and can list a
  history of tokens with their status (unused, in use, expired).
- Set your router's address and a UniFi API key on the add-on's Configuration tab, or leave
  them empty and the app asks for them on first use.

Works with UniFi consoles that have the Network integration API (UniFi Network 9 or later).

## Install

1. Home Assistant → Settings → Add-ons → Add-on Store → ⋮ → **Repositories**, add
   `https://github.com/imne/unifi-guest-wifi-ha-addon`.
2. Install **Guest WiFi Manager**, start it, and turn on **Show in sidebar**.
3. Enter the router's address and API key on the **Configuration** tab (or leave them empty
   and enter them in the app). The key comes from UniFi Network → Settings → Control Plane →
   Integrations → Create API Key.

Without GitHub: copy the `guest_wifi` folder to `/addons/guest_wifi` on the Home Assistant
machine (Samba or SSH add-on), then Add-on Store → ⋮ → Check for updates; it appears under
"Local add-ons".

Automations and the dashboard card are described on the add-on's **Documentation** tab
([guest_wifi/DOCS.md](guest_wifi/DOCS.md)).

## How it works

```
browser ──► Home Assistant (login, ingress proxy)
              └─► add-on :8099 ──► UniFi Network API on your router
```

- `guest_wifi/server.js`: Node 22, no dependencies. Only Home Assistant's ingress proxy may
  connect; it supplies the signed-in user. Writes need a custom header (CSRF protection).
- `guest_wifi/automations.js`: listens for the `guest_wifi_generate` event, publishes
  `sensor.guest_wifi_last_token`, installs the dashboard card (`guest_wifi/card/`).
- `blueprints/script/`: script blueprint that returns the code to an automation.
- `guest_wifi/public/`: the UI (plain HTML/CSS/JS, light and dark mode).
- The router's address and API key come from the add-on's options (`/data/options.json`),
  or from the in-app setup (`/data/settings.json`) when the options are empty.
- By default only Home Assistant administrators see the panel (`panel_admin` in
  `guest_wifi/config.yaml`).

## Test without Home Assistant

```bash
OPTIONS_FILE=/tmp/guest-wifi-options.json SETTINGS_FILE=/tmp/guest-wifi-settings.json ALLOWED_CLIENT_IPS=127.0.0.1 HOST=127.0.0.1 node guest_wifi/server.js
```

```bash
node dev/ha-ingress-sim.js
```

Then open http://127.0.0.1:8123: a stand-in for Home Assistant's ingress proxy (frame,
path prefix, user headers).

## Release

Bump `version` in `guest_wifi/config.yaml` (and `package.json`), push; Home Assistant offers
the update.
