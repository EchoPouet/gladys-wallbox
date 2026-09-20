# Gladys Wallbox

External [Gladys Assistant](https://gladysassistant.com) integration for [Wallbox](https://wallbox.com) EV chargers. It monitors and controls your charging stations through the **Wallbox cloud** — no local network access required.

## Documentation

Detailed, user-oriented documentation is available in the [`docs/`](./docs) folder:

- [English](./docs/en.md) — overview, prerequisites, configuration, published devices and troubleshooting.
- [Français](./docs/fr.md) — the same documentation in French.

The documentation is also re-hosted by Gladys and linked from the **Configuration** screen of the integration.

## Features

- **Discovers every charger** attached to your Wallbox account (`/v3/chargers/groups`) and publishes **one device each**.
- **Monitoring** per charger: state of charge (%), charging power (kW), added energy / green / grid (kWh), added range (km), charging speed (km/h), max available power (A), status text, currency.
- **Control** per charger: pause / resume, lock / unlock, maximum charging current (A), **Solar charging** mode (Off / Eco-Smart / Full solar), resume-schedule and firmware-update one-shot buttons.
- Model-specific capabilities (e.g. bidirectional discharge on the **QS** series) are only published when the charger supports them, like Home Assistant.

## Notes

- Requires **Gladys Assistant ≥ 4.86.0** and an active [Wallbox account](https://my.wallbox.com).
- The account password is stored **encrypted by Gladys** (secret field) and never sent back to the frontend.
- Because it relies on a **cloud** API, the transport badge stays **cloud** while the API answers and switches to **unreachable** otherwise.
- The Wallbox API **rate-limits** aggressive polling (HTTP 429); the default 90-second refresh interval balances freshness with those limits. The effective interval is multiplied by the number of chargers (90s x N), like Home Assistant.

## Run it locally

```bash
npm install
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="wallbox" \
LOG_LEVEL=debug \
npm start
```

The three `GLADYS_*` variables are injected by the Gladys supervisor when the integration runs inside its sandboxed container. The SDK reads them automatically.

## License

Apache-2.0
