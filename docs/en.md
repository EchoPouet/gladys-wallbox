# Wallbox integration

This integration **monitors and controls** your **Wallbox electric vehicle chargers** through the **Wallbox cloud**: charging power, state of charge, added energy (total / green / grid), pause/resume, lock, maximum charging current and **"Solar charging"** (Eco-Smart) mode.

It is inspired by the [Home Assistant integration](https://www.home-assistant.io/integrations/wallbox/) and uses the same [API library](https://pypi.org/project/wallbox/).

## Prerequisites

- An active **Wallbox** account (https://my.wallbox.com).
- Your charger(s) registered on that account.
- To **control** the charger (pause, lock, max current, Eco-Smart), the account must have **admin rights** on the station.

## Configuration

1. Install the integration from the Gladys catalog.
2. Enter the **username** (your Wallbox account email) and **password**.
3. Choose the **refresh interval** (15 to 3600 seconds, 90 by default).

The integration automatically discovers **all chargers** on the account and publishes **one device per charger**. No local network access required: everything goes through the **Wallbox cloud**.

## Published devices

Values are published in Gladys units (kW, kWh, %, km, km/h, A), rounded to **at most 3 decimal places**.

Each charger exposes:

- **Sensors**: state of charge (%), charging power (kW), added energy (kWh), added green energy (kWh), added grid energy (kWh), added range (km), charging speed (km/h), max available power (A), status text (e.g. "Charging", "Paused"), currency.
- **Controls**: pause / resume, lock / unlock, maximum charging current (A), "Solar charging" (Off / Eco-Smart / Full solar), resume-schedule and firmware-update buttons.

Some capabilities are **model-specific** and only appear when the charger supports them (same behaviour as Home Assistant): for example discharged energy on bidirectional stations (the **QS** series).

## Security

- The **password** of your Wallbox account is **stored encrypted by Gladys** and **never sent back to the frontend** (`secret` field).
- Every request goes over **HTTPS** to `api.wall-box.com` and `user-api.wall-box.com`.
- Because this is a **cloud** API, the transport badge of each device is **cloud** under normal operation, and switches to **unreachable** when the Wallbox API stops responding or refuses your credentials.

## Troubleshooting

- **"Wallbox refused the credentials"**: wrong username or password (`secret` field), or the account has no rights on the station. Check in the Wallbox portal.
- **"Wallbox cloud unreachable"**: network issue or the Wallbox API is temporarily unavailable. The badge switches to **unreachable**.
- **No discharge / ICP current data**: your charger model (e.g. Pulsar Plus) does not provide these measurements — the integration does not publish them, like Home Assistant.
- **Pause / resume not working**: some stations only allow pausing when a vehicle is plugged in, and the account must have admin rights.

## Known limitations

- The Wallbox API **rate-limits** requests (HTTP 429): too low a refresh interval can hit these limits. The 90-second default is a good balance. The effective interval is multiplied by the number of chargers on the account (90s x N), like Home Assistant.
- The integration relies on Wallbox's **undocumented public API**; Wallbox may change it without notice.
