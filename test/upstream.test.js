import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, startApp, routesPath } from './helpers/app.js';
import { unusedUrl } from './helpers/osrm-stub.js';
import { reply, SRC, DST_1, DST_2 } from './helpers/fixtures.js';

const FAST = { attemptTimeoutMs: 100, requestTimeoutMs: 1000 };

describe('C. Upstream behaviour', () => {
  for (const [id, code, makeReply] of [
    ['C1', 'NoRoute', reply.noRoute],
    ['C2', 'NoSegment', reply.noSegment],
  ]) {
    test(`${id} ${code} (sent by OSRM as HTTP 400) is not a failure: 200, dst listed as unroutable`, async (t) => {
      const { app, osrm } = await setup(t, ({ dst }) => (dst === DST_2 ? makeReply() : reply.ok()));

      const res = await app.get(routesPath(SRC, [DST_1, DST_2]));

      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {
        source: SRC,
        routes: [{ destination: DST_1, duration: 260.4, distance: 1888 }],
        unroutable: [DST_2],
      });
      assert.equal(osrm.callsFor(DST_2).length, 1, 'no retry for an unroutable pair');
    });
  }

  for (const [code, makeReply] of [
    ['InvalidQuery', reply.invalidQuery],
    ['InvalidOptions', reply.invalidOptions],
    [
      'InvalidUrl',
      () => ({ status: 400, body: { code: 'InvalidUrl', message: 'URL string malformed' } }),
    ],
  ]) {
    test(`C3 ${code} is our bug: 500, logged as an error, generic message`, async (t) => {
      const { app } = await setup(t, makeReply);

      const res = await app.get(routesPath(SRC, [DST_1]));

      assert.equal(res.status, 500);
      assert.deepEqual(await res.json(), { error: 'Internal server error' });
      const logged = app.logs().find((l) => l.msg === 'upstream request failed');
      assert.equal(logged.level, 'error');
      assert.match(logged.detail, new RegExp(code));
    });
  }

  test('C4 OSRM 429 → 503 with Retry-After passed through', async (t) => {
    const { app, osrm } = await setup(t, () => ({ status: 429, headers: { 'Retry-After': '30' } }));

    const res = await app.get(routesPath(SRC, [DST_1]));

    assert.equal(res.status, 503);
    assert.equal(res.headers.get('retry-after'), '30');
    assert.equal(osrm.calls.length, 1, 'a rate limit is not retried');
  });

  test('C4 OSRM 429 without Retry-After → 503 without one', async (t) => {
    const { app } = await setup(t, () => ({ status: 429, body: 'Too Many Requests' }));

    const res = await app.get(routesPath(SRC, [DST_1]));

    assert.equal(res.status, 503);
    assert.equal(res.headers.get('retry-after'), null);
  });

  for (const status of [500, 502, 503]) {
    test(`C5 OSRM ${status} → 502`, async (t) => {
      const { app } = await setup(t, () => ({ status, body: 'upstream broke' }));

      const res = await app.get(routesPath(SRC, [DST_1]));

      assert.equal(res.status, 502);
    });
  }

  test('C6 OSRM does not answer within the timeout → 504', async (t) => {
    const { app } = await setup(t, () => ({ hang: true }), FAST);

    const res = await app.get(routesPath(SRC, [DST_1]));

    assert.equal(res.status, 504);
  });

  test('C7 connection refused → 502', async (t) => {
    const app = await startApp({ osrmUrl: await unusedUrl() });
    t.after(() => app.close());

    const res = await app.get(routesPath(SRC, [DST_1]));

    assert.equal(res.status, 502);
  });

  test('C7 DNS failure → 502', async (t) => {
    const app = await startApp({ osrmUrl: 'http://osrm.invalid' }); // .invalid never resolves
    t.after(() => app.close());

    const res = await app.get(routesPath(SRC, [DST_1]));

    assert.equal(res.status, 502);
  });

  const okBody = reply.ok().body;
  for (const [name, body] of [
    ['malformed JSON', '{"code":"Ok","routes":[{'],
    ['routes: []', { ...okBody, routes: [] }],
    ['routes[0] without duration', { ...okBody, routes: [{ distance: 1888 }] }],
  ]) {
    test(`C8 ${name} → 502, not retried`, async (t) => {
      const { app, osrm } = await setup(t, () => ({ status: 200, body }));

      const res = await app.get(routesPath(SRC, [DST_1]));

      assert.equal(res.status, 502);
      assert.deepEqual(await res.json(), { error: 'Routing service unavailable' });
      assert.equal(osrm.calls.length, 1);
    });
  }

  test('C9 partial failure (3 of 5 succeed, 2 time out) fails the whole request', async (t) => {
    // Policy: a "fastest first" list with a destination silently missing is a
    // wrong answer that looks right, so the whole request fails and the client retries.
    const dsts = ['13.41,52.51', '13.42,52.51', '13.43,52.51', '13.44,52.51', '13.45,52.51'];
    const hanging = new Set(dsts.slice(3));
    const { app } = await setup(
      t,
      ({ dst }) => (hanging.has(dst) ? { hang: true } : reply.ok()),
      FAST,
    );

    const res = await app.get(routesPath(SRC, dsts));

    assert.equal(res.status, 504);
    assert.deepEqual(Object.keys(await res.json()), ['error']);
  });

  describe('C10 error responses do not leak the dependency', () => {
    const LEAK =
      /osrm|project-osrm|127\.0\.0\.1|localhost|https?:|\.js:\d+|\bat \S+ \(|RoutingError|Error:|InvalidQuery|ECONNREFUSED|HTTP \d/i;

    const scenarios = [
      ['rejected (InvalidQuery)', () => reply.invalidQuery()],
      ['rate limited (429)', () => ({ status: 429 })],
      ['server error (503)', () => ({ status: 503, body: 'osrm-routed crashed at /srv/osrm' })],
      ['timeout', () => ({ hang: true })],
      ['malformed JSON', () => ({ status: 200, body: '<html>osrm</html>' })],
    ];

    for (const [name, handler] of scenarios) {
      test(name, async (t) => {
        const { app } = await setup(t, handler, FAST);

        const res = await app.get(routesPath(SRC, [DST_1]));
        const text = await res.text();

        assert.ok(res.status >= 500);
        assert.deepEqual(Object.keys(JSON.parse(text)), ['error']);
        assert.doesNotMatch(text, LEAK);
        assert.equal(res.headers.get('x-powered-by'), null);
      });
    }

    test('connection refused', async (t) => {
      const app = await startApp({ osrmUrl: await unusedUrl() });
      t.after(() => app.close());

      const text = await (await app.get(routesPath(SRC, [DST_1]))).text();

      assert.doesNotMatch(text, LEAK);
    });
  });
});
