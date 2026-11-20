# Guest WiFi Manager

Generate guest WiFi tokens (UniFi hotspot vouchers) from the Home Assistant sidebar.

## Setup

1. In UniFi Network: Settings → Control Plane → Integrations → **Create API Key**.
2. On the add-on's **Configuration** tab, fill in:
   - **Router address**: your UniFi console, for example `192.168.1.1`
   - **API key**: the key from step 1
   - **Verify the router's certificate**: leave off for a console with its built-in
     self-signed certificate
3. Save, start (or restart) the add-on, and open **Guest WiFi** in the sidebar.

### Or set it up in the app

Leave the router address and API key empty on the Configuration tab. The app then asks for
them the first time you open it, checks them against the router, and remembers them. Change
them later with **Router settings** at the top of the page.

Values on the Configuration tab always win; while they are set, the app has no
"Router settings" link.

## Who can use it

Whoever is signed in to Home Assistant and can see the panel. By default only
administrators see it (`panel_admin: true` in `config.yaml`).

## Good to know

- A token's lifetime counts from the guest's first login, not from when it is generated.
- Only tokens made by this app (note starting with `guest-wifi`) are listed or can be revoked.
- Home Assistant must be able to reach the UniFi console on port 443.
- The address and API key stay on your Home Assistant machine (the add-on's
  configuration, or its private data folder when entered in the app); the key is never
  shown in the app.
- "Verify the router's certificate" should stay off for a console with its built-in
  self-signed certificate.
