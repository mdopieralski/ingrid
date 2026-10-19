import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, routesPath } from './helpers/app.ts';
import { SRC, DST_1, DST_2 } from './helpers/fixtures.ts';

// The only test that talks to the real OSRM. Skipped by default so the suite
// runs offline; run it with `pnpm test:integration`.
test(
  'integration: the brief’s request against the real OSRM',
  { skip: !process.env.OSRM_INTEGRATION && 'set OSRM_INTEGRATION=1 to run' },
  async (t) => {
    const app = await startApp(process.env.OSRM_URL ? { osrmUrl: process.env.OSRM_URL } : {});
    t.after(() => app.close());

    const res = await app.get(routesPath(SRC, [DST_1, DST_2]));
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.source, SRC);
    assert.deepEqual(body.routes.map((r) => r.destination).sort(), [DST_1, DST_2].sort());
    for (const route of body.routes) {
      assert.ok(route.duration > 0 && route.distance > 0);
    }
    const [first, second] = body.routes;
    assert.ok(first && second && first.duration <= second.duration);
  },
);
