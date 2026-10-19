import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { setup, routesPath } from './helpers/app.ts';
import { reply, okWith, SRC, DST_1, DST_2 } from './helpers/fixtures.ts';

describe('D. Resilience', () => {
  test('D1 a single 500 is retried exactly once and the request succeeds', async (t) => {
    const { app, osrm } = await setup(t, ({ attempt }) =>
      attempt === 1 ? { status: 500 } : reply.ok(),
    );

    const res = await app.get(routesPath(SRC, [DST_1]));

    assert.equal(res.status, 200);
    assert.equal(osrm.calls.length, 2);
  });

  test('D2 a 400 is not retried', async (t) => {
    const { app, osrm } = await setup(t, () => reply.invalidQuery());

    await app.get(routesPath(SRC, [DST_1]));

    assert.equal(osrm.calls.length, 1);
  });

  test('D3 retries are bounded by maxAttempts and finish inside the deadline', async (t) => {
    const requestTimeoutMs = 2000;
    const { app, osrm } = await setup(t, () => ({ status: 503 }), {
      maxAttempts: 3,
      retryDelayMs: 20,
      requestTimeoutMs,
    });

    const started = performance.now();
    const res = await app.get(routesPath(SRC, [DST_1]));
    const elapsed = performance.now() - started;

    assert.equal(res.status, 502);
    assert.equal(osrm.calls.length, 3);
    assert.ok(elapsed < requestTimeoutMs, `took ${elapsed} ms`);
  });

  test('D4 20 destinations run in parallel, never more than the cap in flight', async (t) => {
    const latencyMs = 50;
    const concurrency = 5;
    const dsts = Array.from({ length: 20 }, (_, i) => `13.${400 + i},52.52`);
    const { app, osrm } = await setup(
      t,
      () => ({ ...okWith({ duration: 100, distance: 1000 }), delayMs: latencyMs }),
      { concurrency },
    );

    const started = performance.now();
    const res = await app.get(routesPath(SRC, dsts));
    const elapsed = performance.now() - started;

    assert.equal(res.status, 200);
    assert.equal(osrm.calls.length, 20);
    assert.equal(osrm.maxInFlight, concurrency);
    // Sequential would be ≈ 20 × 50 = 1000 ms; capped-parallel is ≈ 4 × 50 = 200 ms.
    assert.ok(elapsed < 20 * latencyMs * 0.6, `took ${elapsed} ms`);
  });

  test('D5 the deadline is per request: a slow destination cannot outlive it with retries', async (t) => {
    const requestTimeoutMs = 300;
    const { app, osrm } = await setup(
      t,
      ({ dst }) => (dst === DST_1 ? { hang: true } : reply.ok2()),
      {
        requestTimeoutMs,
        attemptTimeoutMs: 5000, // longer than the deadline, so only the deadline can stop it
        maxAttempts: 3,
      },
    );

    const started = performance.now();
    const res = await app.get(routesPath(SRC, [DST_1, DST_2]));
    const elapsed = performance.now() - started;

    assert.equal(res.status, 504);
    assert.ok(elapsed < requestTimeoutMs + 300, `took ${elapsed} ms`);

    await sleep(200);
    assert.equal(osrm.callsFor(DST_1).length, 1, 'no retry started after the deadline');
    assert.equal(osrm.inFlight, 0, 'the slow call was aborted');
  });
});
