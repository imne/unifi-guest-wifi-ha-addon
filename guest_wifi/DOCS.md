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

## Use it in automations

Import the script blueprint (Settings → Automations & scenes → Blueprints → Import
blueprint):

    https://github.com/imne/unifi-guest-wifi-ha-addon/blob/main/blueprints/script/guest_wifi_generate_token.yaml

Create a script from it, for example `script.guest_wifi_generate_token`. Calling the script
creates the tokens and hands them back to the automation:

```yaml
actions:
  - action: script.guest_wifi_generate_token
    data:
      count: 1                # optional, default 1
      lifetime_minutes: 1440  # optional, default from the script
      devices: 1              # optional, devices per token
      note: Front door        # optional
    response_variable: wifi
  - action: notify.mobile_app_my_phone
    data:
      message: >-
        {% if wifi.code %}Guest WiFi code: {{ wifi.code }}
        {% else %}Could not make a WiFi code: {{ wifi.error }}{% endif %}
```

`wifi.code` is the first token, `wifi.codes` all of them, and `wifi.error` says what went
wrong (then `wifi.code` is empty).

Under the hood, for your own scripts: the add-on listens for the event
`guest_wifi_generate` (data: `count`, `lifetime_minutes`, `devices`, `note`, `request_id`),
then updates `sensor.guest_wifi_last_token` (state: the newest code; attributes: `codes`,
`request_id`, `error`, ...) and fires `guest_wifi_tokens_generated` or
`guest_wifi_generate_failed`. As a safety net, automations can create at most 60 tokens
per hour.

## Dashboard card

The add-on installs a **Guest WiFi** card: it shows the latest token with a Copy button
and makes a new one with one tap.

1. Start the add-on. Its log says "dashboard card installed". If the log also asks for it,
   restart Home Assistant once (needed the first time Home Assistant gets a `www` folder).
2. Edit a dashboard → Add card → search for **Guest WiFi** (reload the browser page if it
   is not listed).

Card settings: title, default lifetime, devices per token, note, and **script**. Without a
script only administrators can generate tokens from the card. To let other users do it,
set the script you created from the blueprint above.

The card is copied to `www/guest-wifi-manager/` in your Home Assistant configuration and
registered under Settings → Dashboards → ⋮ → Resources. Turn off "Install the dashboard
card" on the Configuration tab if you don't want that. With dashboards in YAML mode, add
the resource yourself: `/local/guest-wifi-manager/guest-wifi-card.js`, type `module`.

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
