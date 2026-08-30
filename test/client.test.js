// -----------------------------------------------------------------------------
// Unit + security tests for the Wallbox cloud client.
// -----------------------------------------------------------------------------

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertChargerId,
  MAX_RESPONSE_BYTES,
  resetRequestImpl,
  setRequestImpl,
  WallboxClient,
  WallboxError,
} from '../src/client.js';

const SIGNIN = 'https://user-api.wall-box.com/users/signin';

/**
 * In-memory stand-in for `node:https.request(options, callback)`.
 *
 * It models enough of the real API for the security checks:
 *   - per-URL queues of { status, body } responses (shifted on each call);
 *   - response events emitted in a microtask AFTER the caller wired
 *     `req.on('error')`, `req.setTimeout(...)` and `req.end()`, so the client
 *     sees the same ordering as the real stream;
 *   - `destroy(err)` surfaces `err` through the registered 'error' handler;
 *   - `setTimeout(ms, cb)` stores the callback so tests can fire it.
 *
 * A `body` may be an object (JSON-serialized), a raw string (sent verbatim),
 * or null (no body).
 */
function createMockRequest() {
  const seen = [];
  const queues = new Map(); // url -> array of { status, body }
  let pendingTimeout = null;

  const requestImpl = (options, callback) => {
    const record = {
      url: options.url,
      method: options.method,
      headers: options.headers,
      body: null,
    };
    seen.push(record);

    const queue = queues.get(options.url) ?? [];
    const response = queue.length > 0 ? queue.shift() : { status: 404, body: null };
    let body = response.body;
    if (typeof body === 'function') body = body();
    const raw =
      body === null || body === undefined
        ? null
        : typeof body === 'string'
          ? body
          : JSON.stringify(body);

    let destroyed = false;
    let errorHandler = null;
    const dataHandler = [];
    const endHandler = [];
    const hang = response.__hang;

    const res = {
      statusCode: response.status,
      on: (event, handler) => {
        if (event === 'data') dataHandler.push(handler);
        if (event === 'end') endHandler.push(handler);
        return res;
      },
    };

    callback(res);

    const clientReq = {
      on: (event, handler) => {
        if (event === 'error') errorHandler = handler;
      },
      setTimeout: (ms, cb) => {
        pendingTimeout = cb;
        void ms;
      },
      destroy(err) {
        destroyed = true;
        if (err && errorHandler) errorHandler(err);
      },
      write: (chunk) => {
        record.body = record.body ?? Buffer.alloc(0);
        record.body = Buffer.concat([record.body, Buffer.from(chunk)]);
      },
      end: () => {
        if (record.body) record.body = JSON.parse(record.body.toString('utf8'));
      },
    };

    queueMicrotask(() => {
      if (destroyed || hang) return;
      if (raw !== null) {
        for (const h of dataHandler) h(Buffer.from(raw, 'utf8'));
      }
      // A data handler may have destroyed the request (e.g. oversized body):
      // the real stream would then stop, so do not emit 'end' after a destroy.
      if (!destroyed) for (const h of endHandler) h();
    });

    return clientReq;
  };

  return {
    requestImpl: (options, callback) => requestImpl(options, callback),
    seen,
    queue: (url, status, body, opts = {}) => {
      if (!queues.has(url)) queues.set(url, []);
      queues.get(url).push({ status, body, __hang: opts.hang });
    },
    fireTimeout: () => {
      if (pendingTimeout) pendingTimeout();
    },
  };
}

let mock;

beforeEach(() => {
  mock = createMockRequest();
  setRequestImpl(mock.requestImpl);
});

afterEach(() => {
  resetRequestImpl();
});

test('getChargersList signs in first, then calls the groups endpoint', async () => {
  mock.queue(SIGNIN, 200, { data: { attributes: { token: 'jwt-abc' } } });
  const groups = 'https://api.wall-box.com/v3/chargers/groups';
  mock.queue(groups, 200, {
    result: { groups: [{ chargers: [{ id: 1 }, { id: 2 }] }, { chargers: [{ id: 3 }] }] },
  });

  const client = new WallboxClient({ username: 'u', password: 'p' });
  const ids = await client.getChargersList();

  assert.deepEqual(ids, [1, 2, 3]);
  const signCall = mock.seen.find((c) => c.url === SIGNIN);
  // The user API only accepts GET on /users/signin (405 on POST).
  assert.equal(signCall.method, 'GET');
  assert.equal(signCall.headers.Partner, 'wallbox');
  assert.match(signCall.headers.authorization, /^Basic /);
  const groupsCall = mock.seen.find((c) => c.url === groups);
  assert.equal(groupsCall.headers.authorization, 'Bearer jwt-abc');
});

test('getChargerStatus returns the raw payload', async () => {
  mock.queue(SIGNIN, 200, { data: { attributes: { token: 'jwt-abc' } } });
  const statusUrl = 'https://api.wall-box.com/chargers/status/1';
  mock.queue(statusUrl, 200, { id: 1, state_of_charge: 42 });

  const client = new WallboxClient({ username: 'u', password: 'p' });
  const status = await client.getChargerStatus(1);

  assert.equal(status.state_of_charge, 42);
});

test('controls issue the expected method, path and JSON body', async () => {
  mock.queue(SIGNIN, 200, { data: { attributes: { token: 'jwt-abc' } } });
  const url = 'https://api.wall-box.com/v2/charger/7';
  mock.queue(url, 200, { result: { locked: 1 } });

  const client = new WallboxClient({ username: 'u', password: 'p' });
  await client.setLocked(7, true);

  const call = mock.seen.find((c) => c.url === url);
  assert.equal(call.method, 'PUT');
  assert.match(call.headers['content-type'], /application\/json/);
  assert.deepEqual(call.body, { locked: 1 });
});

test('non-2xx responses are raised as WallboxError with the status code', async () => {
  mock.queue(SIGNIN, 200, { data: { attributes: { token: 'jwt-abc' } } });
  mock.queue('https://api.wall-box.com/v3/chargers/groups', 500, {});

  const client = new WallboxClient({ username: 'u', password: 'p' });
  await assert.rejects(client.getChargersList(), (err) => {
    assert.ok(err instanceof WallboxError);
    assert.equal(err.status, 500);
    return true;
  });
});

test('a bad credential is NOT retried (single failing sign-in)', async () => {
  // The sign-in itself 401s: there is no valid token to refresh, so the client
  // must propagate 401 without an extra retry round.
  mock.queue(SIGNIN, 401, { error: 'unauthorized' });

  const client = new WallboxClient({ username: 'u', password: 'p' });
  await assert.rejects(client.getChargersList(), (err) => {
    assert.ok(err instanceof WallboxError);
    assert.equal(err.status, 401);
    return true;
  });
  assert.equal(mock.seen.filter((c) => c.url === SIGNIN).length, 1);
});

test('assertChargerId only accepts a positive integer', () => {
  assert.equal(assertChargerId(7), 7);
  assert.equal(assertChargerId('7'), 7); // numeric strings coerce
  assert.throws(() => assertChargerId('../../etc/passwd'), WallboxError);
  assert.throws(() => assertChargerId('abc'), WallboxError);
  assert.throws(() => assertChargerId(0), WallboxError);
  assert.throws(() => assertChargerId(-1), WallboxError);
});

test('an invalid charger id is rejected before any HTTP call', async () => {
  const client = new WallboxClient({ username: 'u', password: 'p' });
  await assert.rejects(client.getChargerStatus('../../etc/passwd'), WallboxError);
  await assert.rejects(client.setLocked('..%2f..', true), WallboxError);
  // No request of any kind left the client (SSRF / path-traversal guard).
  assert.equal(mock.seen.length, 0);
});

test('an oversized response body is aborted (memory guard)', async () => {
  mock.queue(SIGNIN, 200, { data: { attributes: { token: 'jwt-abc' } } });
  mock.queue('https://api.wall-box.com/chargers/status/1', 200, 'X'.repeat(MAX_RESPONSE_BYTES + 1));

  const client = new WallboxClient({ username: 'u', password: 'p' });
  await assert.rejects(client.getChargerStatus(1), WallboxError);
});

test('a malformed JSON success response is raised as WallboxError', async () => {
  mock.queue(SIGNIN, 200, { data: { attributes: { token: 'jwt-abc' } } });
  mock.queue('https://api.wall-box.com/chargers/status/1', 200, 'not-json');

  const client = new WallboxClient({ username: 'u', password: 'p' });
  await assert.rejects(client.getChargerStatus(1), WallboxError);
});

test('an expired/refused token triggers a single re-authentication retry', async () => {
  const groups = 'https://api.wall-box.com/v3/chargers/groups';
  mock.queue(SIGNIN, 200, { data: { attributes: { token: 'jwt-first' } } });
  mock.queue(groups, 401, {});
  mock.queue(SIGNIN, 200, { data: { attributes: { token: 'jwt-second' } } });
  mock.queue(groups, 200, { result: { groups: [{ chargers: [{ id: 9 }] }] } });

  const client = new WallboxClient({ username: 'u', password: 'p' });
  const ids = await client.getChargersList();

  assert.deepEqual(ids, [9]);
  // Two sign-ins happened (one per authentication round).
  assert.equal(mock.seen.filter((c) => c.url === SIGNIN).length, 2);
  // The second groups call carried a fresh token.
  const groupsCalls = mock.seen.filter((c) => c.url === groups);
  assert.equal(groupsCalls.length, 2);
  assert.equal(groupsCalls[1].headers.authorization, 'Bearer jwt-second');
});

test('a request that never responds is aborted by the timeout', async () => {
  mock.queue(SIGNIN, 200, { data: { attributes: { token: 'jwt-abc' } } });
  mock.queue('https://api.wall-box.com/chargers/status/1', 200, null, { hang: true });

  const client = new WallboxClient({ username: 'u', password: 'p' });
  const promise = client.getChargerStatus(1);
  const assertion = assert.rejects(promise, WallboxError);

  // Simulate the API never responding: the setTimeout callback must abort it.
  setImmediate(() => mock.fireTimeout());
  await assertion;
});
