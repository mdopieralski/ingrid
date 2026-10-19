import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, routesPath, type TestApp } from './helpers/app.ts';
import { startOsrmStub, type OsrmStub } from './helpers/osrm-stub.ts';
import { reply, SRC, DST_1 } from './helpers/fixtures.ts';

// Every case checks two things: the 400, and that OSRM was never called.
describe('B. Input validation — 400, and OSRM is never called', () => {
  let osrm: OsrmStub;
  let app: TestApp;
  before(async () => {
    osrm = await startOsrmStub(() => reply.ok());
    app = await startApp({ osrmUrl: osrm.url, maxDestinations: 100 });
  });
  after(() => Promise.all([app.close(), osrm.close()]));

  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => `13.${String(i).padStart(4, '0')},52.5`);

  const cases: [name: string, path: string, message: RegExp][] = [
    ['B1 src missing', routesPath(undefined, [DST_1]), /"src"/],
    ['B2 src supplied twice', `/routes?src=${SRC}&src=${SRC}&dst=${DST_1}`, /Exactly one "src"/],
    ['B3 no dst at all', routesPath(SRC, []), /"dst"/],
    ['B4 src=abc,def', routesPath('abc,def', [DST_1]), /Invalid "src"/],
    ['B4 src in hex (0x10,5)', routesPath('0x10,5', [DST_1]), /Invalid "src"/],
    ['B4 src with exponent (1e1,5)', routesPath('1e1,5', [DST_1]), /Invalid "src"/],
    ['B5 src with one component', routesPath('13.38', [DST_1]), /Invalid "src"/],
    ['B6 dst present but empty', `/routes?src=${SRC}&dst=`, /Invalid "dst"/],
    ['B7 longitude out of range', routesPath('200.0,52.5', [DST_1]), /Invalid "src"/],
    ['B7 latitude out of range', routesPath('13.38,91.0', [DST_1]), /Invalid "src"/],
    ['B8 dst repeated 500 times', routesPath(SRC, many(500)), /max 100/],
    ['B8 dst one over the cap', routesPath(SRC, many(101)), /max 100/],
  ];

  for (const [name, path, message] of cases) {
    test(name, async () => {
      const before = osrm.calls.length;

      const res = await app.get(path);

      assert.equal(res.status, 400);
      assert.match((await res.json()).error, message);
      assert.equal(osrm.calls.length, before, 'OSRM must not be called');
    });
  }

  test('B8 exactly at the cap is accepted', async () => {
    const res = await app.get(routesPath(SRC, many(100)));

    assert.equal(res.status, 200);
  });

  test('B9 a swapped lat,lon pair is a legal coordinate and cannot be rejected', async () => {
    // 52.517037,13.388860 is a real point (in Turkey). The API is lon,lat, as
    // in the brief's example and in OSRM; a swapped pair is a caller error we
    // cannot detect.
    const res = await app.get(routesPath('52.517037,13.388860', [DST_1]));

    assert.equal(res.status, 200);
    assert.equal(osrm.calls.at(-1)?.src, '52.517037,13.388860');
  });
});
