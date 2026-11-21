# Changelog

What changed in each version of Unifi Guest Wi-Fi Voucher Generator, newest first. Home Assistant shows this
when an update is offered and on the add-on's Changelog tab.

## 1.4.0 (2026-11-21)

- **Everyone can generate tokens**, not only administrators.
  - The **Guest WiFi** sidebar entry is now shown to every Home Assistant user. They can
    generate tokens, see recent ones and revoke them.
  - The dashboard card works for everyone without any setup. The add-on creates
    `script.guest_wifi_generate_token` for this, and the card uses it automatically.
- **Only administrators can connect or change the router.** Other users see no "Router
  settings" link, and a short notice if the router is not connected yet.
- New option **Administrators only**: turn it on to keep the old behaviour, where only
  administrators can open Guest WiFi and generate tokens.
- New option **Create the token script** (on by default).

**Good to know:** the sidebar entry is visible to all users from this version on. If you
do not want that, turn on **Administrators only** on the Configuration tab.

**After updating:** restart the add-on, then reload the dashboard in your browser. If you
made your own script from the blueprint, it keeps working; the add-on only creates its
script when `script.guest_wifi_generate_token` does not exist yet.

## 1.3.2 (2026-11-20)

- The add-on is now called **Unifi Guest Wi-Fi Voucher Generator** (it was "Guest WiFi
  Manager"). Only the name shown in Home Assistant and on the add-on's page changed.
- Nothing else is renamed: the **Guest WiFi** sidebar entry and dashboard card, the
  sensors, the event names and your scripts and automations all keep working as they are.
- Release notes: from this version on, every update lists what changed here.

## 1.3.1 (2026-11-20)

- The **Guest WiFi** dashboard card now shows a live preview in the "Add card" picker.

**After updating:** reload the dashboard in your browser (hard refresh if the old card
still shows).

## 1.3.0 (2026-11-20)

- **Token history on the dashboard card.** Below the latest token, the card lists the
  newest tokens, each marked **Unused**, **In use** (with the time it ends) or **Expired**.
- **History switch on the card.** Turns the list on or off; each browser remembers its own
  choice.
- New card settings: `show_history` (whether the history starts switched on) and
  `history_count` (how many tokens it lists, up to 10).
- New sensor `sensor.guest_wifi_tokens`: the number of unused tokens, with the newest ten
  and their status as attributes. It refreshes about once a minute and after every change.
- The add-on's own page now always lists the newest tokens first, also when there are
  many.

**Good to know:** token codes are readable in that sensor by anyone who can see entities
in your Home Assistant.

**After updating:** reload the dashboard in your browser.

## 1.2.0 (2026-11-20)

- **Automations can create tokens and get the code back.** Import the script blueprint
  from the repository, then call the script with `response_variable` and use
  `{{ wifi.code }}`. Details are on the Documentation tab.
- New event `guest_wifi_generate` to request tokens, answered by the events
  `guest_wifi_tokens_generated` / `guest_wifi_generate_failed`.
- New sensor `sensor.guest_wifi_last_token` with the newest token.
- **Dashboard card.** The add-on installs a **Guest WiFi** card that shows the latest token
  with a Copy button and makes a new one with one tap.
- New option **Install the dashboard card** (on by default).
- Safety net: automations can create at most 60 tokens per hour.

**Good to know:** the add-on now asks for two more permissions: access to Home Assistant's
API (for automations) and write access to the configuration folder (only to copy the card
into `www/guest-wifi-manager/`).

**After updating:** check the add-on's Log tab. If it asks for it, restart Home Assistant
once so the card can load.

## 1.1.0 (2026-11-20)

- **Router address and API key as add-on options.** Set them on the Configuration tab,
  together with **Verify the router's certificate**.
- Values on the Configuration tab win over the ones entered in the app. Leave them empty to
  keep using the in-app setup.
- Clearer messages when the address, the API key or the certificate is wrong.

**After updating:** nothing to do. If you set options, restart the add-on so it picks them
up.

## 1.0.1 (2026-11-20)

- Added an icon and a logo for the add-on.

## 1.0.0 (2026-11-20)

First release.

- **Guest WiFi** panel in the Home Assistant sidebar, signed in by Home Assistant
  (administrators only by default).
- Create guest WiFi tokens (UniFi hotspot vouchers): number of tokens, lifetime from 1 hour
  to 30 days, devices per token and a note.
- Copy one or all codes, download a CSV, or print cut-out cards.
- List recent tokens with their status and revoke them.
- First-run setup in the app: enter the router's address and a UniFi API key; they are
  checked against the router before being saved.
