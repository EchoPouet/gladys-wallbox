# AGENTS.md

Guidance for developers and AI agents working on this codebase. Everything user-facing lives in [`docs/`](./docs) and is documented in the [README](./README.md).

## What this integration demonstrates

External [Gladys Assistant](https://gladysassistant.com) integration for **Wallbox EV chargers** through the **Wallbox cloud** (`api.wall-box.com` / `user-api.wall-box.com`). Wallbox exposes no local API: every read and every command goes through the cloud.

| Role             | File                           | What it illustrates                                                                                    |
| ---------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Cloud client     | `src/client.js`                | Credential auth (`GET /users/signin`), cached JWT, typed errors (`WallboxError`), injectable `request` |
| Device blueprint | `src/devices/chargerDevice.js` | Read-only sensors + commands, mapping of Wallbox keys to Gladys features, model-conditional features   |
| Registry         | `src/devices/index.js`         | One device type, many devices (one per charger)                                                        |
| Bootstrap        | `index.js`                     | SDK wiring, lifecycle, discovery, cloud polling, transport badge                                       |

## Project structure

```
.
├─ index.js                          # SDK bootstrap + event wiring (no device logic)
├─ src/
│  ├─ devices/
│  │  ├─ index.js                    # blueprint registry
│  │  └─ chargerDevice.js            # one device per charger (sensors + commands)
│  ├─ client.js                      # Wallbox cloud client
│  └─ config.js                      # config defaults + normalization
├─ docs/
│  ├─ en.md                          # user documentation (re-hosted by Gladys,
│  └─ fr.md                          #   linked from the Configuration screen)
├─ test/…                            # native `node --test` tests
├─ gladys-assistant-integration.json # manifest (name, config_schema, actions, transports, image)
├─ Dockerfile                        # node:24-alpine, read-only rootfs ready
└─ README.md
```

## SDK wiring

- `new GladysIntegration()` reads `GLADYS_HOST_API_URL`, `GLADYS_INTEGRATION_TOKEN` and `GLADYS_INTEGRATION_SELECTOR` automatically.
- The handlers (`onPoll`, `onSetValue`, `onAction`, `onConfigUpdated`, `on('connected'|'disconnected')`, `handleShutdown`) must be registered **before** `connect()`.
- The `WallboxClient` is rebuilt when the credentials change (`onConfigUpdated`), so a stale session token is never reused.
- The transport badge is **cloud** (`DEVICE_TRANSPORTS.CLOUD`) and switches to `UNREACHABLE` when the cloud refuses or stops responding.

## Development rules

- All external identifiers are prefixed with `ext:<selector>:` — always build them with `gladys.externalIds(type, platformId)`. Derive `platformId` from the unique id the platform gives you (serial number, never a generic label).
- Values are published in **kW / kWh** (power / energy), **%** (level), **km / km/h** (distance / speed) and **A** (current), rounded to **3 decimal places maximum**.
- **Model-specific** features (e.g. discharge on bidirectional QS stations) are only declared when the source value is present (`null` = feature omitted), like Home Assistant.
- The `secret` config protects the password in `gladys-assistant-integration.json`.
- The endpoint mapping is based on the [`wallbox`](https://pypi.org/project/wallbox/) library (used by Home Assistant) and on the code from `homeassistant/components/wallbox`.

## Run it locally

```bash
npm install
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="wallbox" \
LOG_LEVEL=debug \
npm start
```

The three `GLADYS_*` variables are injected by the Gladys supervisor; the SDK reads them automatically.

## Quality checks

```bash
npm run format:check   # Prettier: is everything formatted?
npm run format         # Prettier: format everything in place
npm run lint           # ESLint: catch real mistakes (unused vars, dead code…)
npm test               # Unit tests, via the built-in `node --test` runner
```

Tests live in [`test/`](test/) and use Node's native test runner — no extra framework to install. Add a `*.test.js` next to the existing ones and it is picked up automatically.

## Commit message convention

All commit messages must follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

```
<type>(<optional scope>): <subject>
```

- Required **type** from the conventional list: `feat`, `fix`, `docs`, `chore`, `refactor`, `perf`, `test`, `build`… Use `!` after the type/scope (e.g. `feat!:`) for breaking changes.
- **Scope** is optional but encouraged (e.g. `feat(devices):`).
- Keep the subject short, imperative, and lowercase — no trailing period.

Examples:

```
feat: add pause/resume control for Wallbox chargers
fix(client): refresh JWT on 401 before giving up
docs: add Apache License 2.0
```
