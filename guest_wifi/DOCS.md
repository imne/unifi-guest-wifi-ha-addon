# Guest WiFi Manager

Generate guest WiFi tokens (UniFi hotspot vouchers) from the Home Assistant sidebar.

## Setup

1. In UniFi Network: Settings → Control Plane → Integrations → **Create API Key**.
2. Start the add-on and open **Guest WiFi** in the sidebar.
3. The first time, the app asks for your router's address (for example `192.168.1.1`)
   and the API key. It checks them against the router before saving.

To change them later, use **Router settings** at the top of the page.

## Who can use it

Whoever is signed in to Home Assistant and can see the panel. By default only
administrators see it (`panel_admin: true` in `config.yaml`).

## Good to know

- A token's lifetime counts from the guest's first login, not from when it is generated.
- Only tokens made by this app (note starting with `guest-wifi`) are listed or can be revoked.
- Home Assistant must be able to reach the UniFi console on port 443.
- The address and API key are stored in the add-on's private data folder
  (`/data/settings.json`); the key is never shown again in the app.
- "Verify the router's certificate" should stay off for a console with its built-in
  self-signed certificate.
