// -----------------------------------------------------------------------------
// Wallbox cloud API client.
//
// The Wallbox EV chargers expose NO local API: every command and reading goes
// through the Wallbox cloud (https://api.wall-box.com). Authentication is done
// with the account's username/password:
//   GET https://user-api.wall-box.com/users/signin    -> JWT + refresh token
//
// Once authenticated the client caches the JWT and transparently re-authenticates
// when the token is refused (401) — a stale/expired token is never held forever.
// Every public method throws `WallboxError` with a `status` (0 = network/timeout)
// so the integration can tell "invalid credentials" (401/403) apart from
// "cloud unreachable". Security posture:
//   - HTTPS only, against fixed wallbox domains;
//   - a request timeout is enforced (no grafted sockets on an unresponsive API);
//   - response bodies are capped to guard the container memory against an
//     oversized or malicious response.
//
// Endpoints used (all relative to `https://api.wall-box.com`):
//   GET  /v3/chargers/groups             -> every charger id on the account
//   GET  /chargers/status/{id}           -> full status of one charger
//   PUT  /v2/charger/{id}                -> locked / maxChargingCurrent
//   POST /v3/chargers/{id}/remote-action -> pause (2) / resume (1) / schedule (9)
//   POST /chargers/config/{id}           -> icp_max_current, energyCost
//   PUT  /v4/chargers/{id}/eco-smart     -> eco-smart / full solar
//
// Errors are raised as `WallboxError`. The Wallbox API uses a JSON:API-ish
// envelope for sign-in (`payload.data.attributes`) and a flat object for
// charger status (top-level keys + `config_data`).
// -----------------------------------------------------------------------------

import { request as nativeRequest } from 'node:https';

/** Error raised when the Wallbox cloud refuses, is unreachable, or answers
 * something unreadable. `status 0` means the request never completed. */
export class WallboxError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'WallboxError';
    this.status = status; // HTTP status, or 0 for network/timeout failures
  }
}

/** Timeout for every API request, in milliseconds. */
export const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Maximum size of a single API response body, in bytes. Guards the container
 * memory against an oversized or malicious response (CWE-400).
 */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MiB

const AUTH_BASE = 'https://user-api.wall-box.com';
const API_BASE = 'https://api.wall-box.com';

/**
 * The request implementation, injectable for tests. Uses the native `request`
 * by default; tests replace it with an in-memory stand-in.
 */
let requestImpl = nativeRequest;

/** Replace the request implementation (tests only). */
export function setRequestImpl(fn) {
  requestImpl = fn;
}

/** Restore the native request implementation (tests only). */
export function resetRequestImpl() {
  requestImpl = nativeRequest;
}

/** Base64 of `username:password`, used from the sign-in call. */
function basicAuth(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

/**
 * Normalize a charger id to a positive integer. Wallbox charger ids are
 * numeric; interpolating arbitrary strings into a URL path would let a
 * malformed id alter the request path (path traversal / SSRF, CWE-98/918).
 */
export function assertChargerId(id) {
  const normalized = Number(id);
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new WallboxError(0, `Invalid Wallbox charger id: ${id}`);
  }
  return normalized;
}

/**
 * Perform one HTTP request with `requestImpl` and resolve with
 * `{ statusCode, body }` once the response is fully read (and within bounds).
 *
 * The request implementation is expected to match the native `node:https`
 * `request(options, callback)` shape: `callback` receives a response object
 * exposing `statusCode` and `on('data'|'end', handler)`, and the returned
 * request object lets us stage the body with `write()`/`end()`.
 */
async function invokeHttp({ method, url, headers = {}, body, timeoutMs }) {
  const options = {
    hostname: url.hostname,
    port: url.port || 443,
    path: `${url.pathname}${url.search}`,
    method,
    headers: {
      accept: 'application/json',
      ...headers,
      ...(body !== undefined ? { 'content-type': 'application/json;charset=UTF-8' } : {}),
    },
    url: url.toString(),
  };

  let payload;
  if (body !== undefined) {
    payload = Buffer.from(JSON.stringify(body), 'utf8');
    options.headers['content-length'] = String(payload.length);
  }

  return await new Promise((resolve, reject) => {
    let settled = false;
    let totalBytes = 0;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      result instanceof Error ? reject(result) : resolve(result);
    };

    try {
      const req = requestImpl(options, (response) => {
        const statusCode = response.statusCode;
        const chunks = [];
        response.on('data', (chunk) => {
          const buffer = Buffer.from(chunk);
          totalBytes += buffer.length;
          // Hard cap: abort the request as soon as the body exceeds the bound.
          if (totalBytes > MAX_RESPONSE_BYTES) {
            req.destroy?.(new WallboxError(0, 'Wallbox API response too large'));
            return;
          }
          chunks.push(buffer);
        });
        response.on('end', () =>
          settle({ statusCode, body: Buffer.concat(chunks).toString('utf8') }),
        );
      });

      req.on?.('error', (err) =>
        settle(err instanceof WallboxError ? err : new WallboxError(0, String(err))),
      );
      // Enforce a real timeout so an unresponsive API cannot hold sockets open.
      if (timeoutMs) {
        req.setTimeout?.(timeoutMs, () => {
          req.destroy?.(new WallboxError(0, 'Wallbox API timeout'));
        });
      }
      if (payload) req.write(payload);
      req.end();
    } catch (err) {
      settle(new WallboxError(0, String(err)));
    }
  });
}

/**
 * Perform one JSON request and return the parsed body. Throws `WallboxError`
 * on any HTTP failure, transport error, malformed JSON or oversized body.
 */
async function requestJson({ method, url, token, headers = {}, body, timeoutMs }) {
  const parsed = typeof url === 'string' ? new URL(url) : url;
  const requestHeaders = {
    ...headers,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };

  const res = await invokeHttp({ method, url: parsed, headers: requestHeaders, body, timeoutMs });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new WallboxError(res.statusCode, `Wallbox API HTTP ${res.statusCode}`);
  }
  if (!res.body) return {};
  try {
    return JSON.parse(res.body);
  } catch {
    throw new WallboxError(0, 'Wallbox API returned invalid JSON');
  }
}
/**
 * Wallbox cloud client. Caches the session token and transparently
 * re-authenticates when a call is refused with 401 (expired/revoked token),
 * so a stale session is never held forever.
 */
export class WallboxClient {
  constructor({ username, password, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    this.username = username;
    this.password = password;
    this.timeoutMs = timeoutMs;
    this.jwtToken = '';
  }

  get isAuthenticated() {
    return this.jwtToken.length > 0;
  }

  /** Sign-in: fetch a fresh JWT from the account credentials. The Wallbox
   * user API accepts a GET on /users/signin with HTTP Basic auth and the
   * partner header (the endpoint returns 405 on POST). */
  async _signIn() {
    const payload = await requestJson({
      method: 'GET',
      url: `${AUTH_BASE}/users/signin`,
      headers: {
        authorization: basicAuth(this.username, this.password),
        Partner: 'wallbox',
      },
      timeoutMs: this.timeoutMs,
    });
    this.jwtToken = payload?.data?.attributes?.token ?? '';
    if (!this.jwtToken) {
      throw new WallboxError(0, 'Wallbox sign-in returned no token');
    }
  }

  /** Run `fn` with an authenticated session, re-authing once after a 401. */
  async _call(fn) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        if (!this.isAuthenticated) await this._signIn();
        return await fn();
      } catch (err) {
        // A call that 401s despite a valid stored JWT means the token expired or
        // was revoked: drop it and re-authenticate for a single retry. If the
        // sign-in itself 401s, there is no token to refresh — propagate it.
        const tokenWasValid = this.isAuthenticated;
        if (err instanceof WallboxError && err.status === 401 && tokenWasValid && attempt === 0) {
          this.jwtToken = '';
          continue;
        }
        throw err;
      }
    }
    throw new WallboxError(0, 'Authentication retry exhausted'); // unreachable
  }

  /** Every charging station id attached to the account. */
  async getChargersList() {
    return this._call(async () => {
      const payload = await requestJson({
        method: 'GET',
        url: `${API_BASE}/v3/chargers/groups`,
        token: this.jwtToken,
        timeoutMs: this.timeoutMs,
      });
      const groups = payload?.result?.groups ?? [];
      const ids = [];
      for (const group of groups) {
        for (const charger of group?.chargers ?? []) {
          const id = Number(charger?.id);
          if (Number.isInteger(id) && id > 0 && !ids.includes(id)) ids.push(id);
        }
      }
      return ids;
    });
  }

  /** Full status payload of one charger. */
  async getChargerStatus(chargerId) {
    const id = assertChargerId(chargerId);
    return this._call(() =>
      requestJson({
        method: 'GET',
        url: `${API_BASE}/chargers/status/${id}`,
        token: this.jwtToken,
        timeoutMs: this.timeoutMs,
      }),
    );
  }

  /** Generic authenticated mutation helper. `path` may contain `{id}`. */
  async _mutate({ method, path, id, body }) {
    // Validate BEFORE any sign-in / network call: an invalid id must be
    // rejected without touching the network (SSRF / path-traversal guard).
    const safeId = assertChargerId(id);
    return this._call(() =>
      requestJson({
        method,
        url: `${API_BASE}${path.replace('{id}', String(safeId))}`,
        token: this.jwtToken,
        body,
        timeoutMs: this.timeoutMs,
      }),
    );
  }

  /** Pause (true) or resume (false) the charging session. */
  async setPaused(chargerId, pause) {
    return this._mutate({
      method: 'POST',
      path: '/v3/chargers/{id}/remote-action',
      id: chargerId,
      body: { action: pause ? 2 : 1 },
    });
  }

  /** Revert to the default schedule after a manual session. */
  async resumeSchedule(chargerId) {
    return this._mutate({
      method: 'POST',
      path: '/v3/chargers/{id}/remote-action',
      id: chargerId,
      body: { action: 9 },
    });
  }

  /** Lock (true) or unlock (false) the charger. */
  async setLocked(chargerId, locked) {
    return this._mutate({
      method: 'PUT',
      path: '/v2/charger/{id}',
      id: chargerId,
      body: { locked: locked ? 1 : 0 },
    });
  }

  /** Set the maximum charging current, in amperes. */
  async setMaxChargingCurrent(chargerId, amperes) {
    return this._mutate({
      method: 'PUT',
      path: '/v2/charger/{id}',
      id: chargerId,
      body: { maxChargingCurrent: Number(amperes) },
    });
  }

  /** Set the maximum ICP current, in amperes. */
  async setIcpMaxCurrent(chargerId, amperes) {
    return this._mutate({
      method: 'POST',
      path: '/chargers/config/{id}',
      id: chargerId,
      body: { icp_max_current: Number(amperes) },
    });
  }

  /** Set the energy price (currency per kWh), used by the cost estimate. */
  async setEnergyCost(chargerId, cost) {
    return this._mutate({
      method: 'POST',
      path: '/chargers/config/{id}',
      id: chargerId,
      body: { energyCost: Number(cost) },
    });
  }

  /**
   * Enable Eco-Smart / solar charging. `mode` 0 = Eco-Smart, 1 = Full solar.
   */
  async enableEcoSmart(chargerId, mode = 0) {
    return this._mutate({
      method: 'PUT',
      path: '/v4/chargers/{id}/eco-smart',
      id: chargerId,
      body: { data: { attributes: { enabled: 1, mode }, type: 'eco_smart' } },
    });
  }

  /** Disable Eco-Smart / solar charging. */
  async disableEcoSmart(chargerId) {
    return this._mutate({
      method: 'PUT',
      path: '/v4/chargers/{id}/eco-smart',
      id: chargerId,
      body: { data: { attributes: { enabled: 0, mode: 0 }, type: 'eco_smart' } },
    });
  }
}
