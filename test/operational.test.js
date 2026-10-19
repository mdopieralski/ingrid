import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { setup, routesPath } from './helpers/app.js';
import { reply, SRC, DST_1, DST_2 } from './helpers/fixtures.js';

describe('E. Operational surface', () => {
  test('E1 GET /health answers 200 without touching OSRM', async (t) => {
    const { app, osrm } = await setup(t, () => reply.ok());

    const res = await app.get('/health');

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok' });
    assert.equal(osrm.calls.length, 0);
  });

  test('E2 each request writes one structured log line', async (t) => {
    const { app } = await setup(t, ({ dst }) => (dst === DST_1 ? reply.ok() : reply.ok2()));

    const res = await app.get(routesPath(SRC, [DST_1, DST_2]));
    const entry = await app.requestLog();

    assert.equal(entry.requestId, res.headers.get('x-request-id'));
    assert.equal(entry.method, 'GET');
    assert.equal(entry.path, '/routes');
    assert.equal(entry.status, 200);
    assert.equal(entry.destinationCount, 2);
    assert.equal(typeof entry.upstreamLatencyMs, 'number');
    assert.equal(typeof entry.durationMs, 'number');
    assert.equal(entry.outcome, 'ok');
  });

  test('E2 an incoming X-Request-Id is reused', async (t) => {
    const { app } = await setup(t, () => reply.ok());

    const res = await app.get(routesPath(SRC, [DST_1]), { headers: { 'X-Request-Id': 'abc-123' } });

    assert.equal(res.headers.get('x-request-id'), 'abc-123');
    assert.equal((await app.requestLog()).requestId, 'abc-123');
  });

  test('E3 upstream error detail is logged, never returned', async (t) => {
    const { app } = await setup(t, () => ({ status: 503 }));

    const res = await app.get(routesPath(SRC, [DST_1]));
    const body = await res.text();

    const logged = app.logs().find((l) => l.msg === 'upstream request failed');
    assert.match(logged.detail, /HTTP 503/);
    assert.equal(logged.requestId, res.headers.get('x-request-id'));
    assert.doesNotMatch(body, /503/);
    assert.equal((await app.requestLog()).outcome, 'upstream_unavailable');
  });

  test('E4 coordinates never appear in logs', async (t) => {
    const { app } = await setup(t, ({ dst }) => (dst === DST_1 ? reply.ok() : { status: 503 }));

    await app.get(routesPath(SRC, [DST_1])); // success
    await app.get(routesPath(SRC, [DST_1, DST_2])); // upstream failure
    await app.get(routesPath(SRC, ['999,999'])); // validation failure
    await sleep(50);

    const all = app.lines.join('\n');
    for (const value of ['13.388860', '52.517037', '13.397634', '13.428555', '999,999']) {
      assert.ok(!all.includes(value), `log contains ${value}`);
    }
  });

  test('E5 a client disconnect cancels the upstream call', async (t) => {
    const { app, osrm } = await setup(t, () => ({ hang: true }));
    const controller = new AbortController();

    const pending = app.get(routesPath(SRC, [DST_1]), { signal: controller.signal });
    while (osrm.calls.length === 0) await sleep(5);
    controller.abort();
    await pending.catch(() => {});
    await sleep(100);

    assert.equal(osrm.calls.length, 1);
    assert.equal(osrm.calls[0].aborted, true);
    assert.equal((await app.requestLog()).outcome, 'client_cancelled');
  });
});
