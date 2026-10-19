import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, routesPath } from './helpers/app.js';
import { reply, okWith, SRC, DST_1, DST_2 } from './helpers/fixtures.js';

const D = ['13.401,52.521', '13.402,52.522', '13.403,52.523'];

describe('A. Contract & happy path', () => {
  test('A1 the brief’s request returns exactly the specified body', async (t) => {
    const { app } = await setup(t, ({ dst }) => (dst === DST_1 ? reply.ok() : reply.ok2()));

    const res = await app.get(routesPath(SRC, [DST_1, DST_2]));

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.deepEqual(await res.json(), {
      source: SRC,
      routes: [
        { destination: DST_1, duration: 260.4, distance: 1888 },
        { destination: DST_2, duration: 388.6, distance: 3800.9 },
      ],
    });
  });

  test('A2 sorts by duration, not distance: the longer-but-faster route comes first', async (t) => {
    const byDst = {
      [D[0]]: okWith({ duration: 300, distance: 1000 }), // nearest, slowest
      [D[1]]: okWith({ duration: 100, distance: 5000 }), // farthest, fastest
      [D[2]]: okWith({ duration: 200, distance: 3000 }),
    };
    const { app } = await setup(t, ({ dst }) => byDst[dst]);

    const { routes } = await (await app.get(routesPath(SRC, D))).json();

    assert.deepEqual(
      routes.map((r) => r.destination),
      [D[1], D[2], D[0]],
    );
  });

  test('A3 equal durations are tie-broken by shorter distance', async (t) => {
    const byDst = {
      [D[0]]: okWith({ duration: 200, distance: 3000 }),
      [D[1]]: okWith({ duration: 200, distance: 2000 }),
    };
    const { app } = await setup(t, ({ dst }) => byDst[dst]);

    const { routes } = await (await app.get(routesPath(SRC, [D[0], D[1]]))).json();

    assert.deepEqual(
      routes.map((r) => r.destination),
      [D[1], D[0]],
    );
  });

  test('A4 a single dst still returns routes as an array of one', async (t) => {
    const { app } = await setup(t, () => reply.ok());

    const body = await (await app.get(routesPath(SRC, [DST_1]))).json();

    assert.ok(Array.isArray(body.routes));
    assert.equal(body.routes.length, 1);
  });

  test('A5 echoes the client’s coordinate, not the waypoint OSRM snapped to', async (t) => {
    const ok = reply.ok();
    // The real payload snaps 13.397634,52.529407 to 13.39763,52.529433.
    assert.deepEqual(ok.body.waypoints[1].location, [13.39763, 52.529433]);
    const { app } = await setup(t, () => ok);

    const { routes } = await (await app.get(routesPath(SRC, [DST_1]))).json();

    assert.equal(routes[0].destination, DST_1);
  });

  test('A6 a repeated dst is routed once and listed once', async (t) => {
    const { app, osrm } = await setup(t, () => reply.ok());

    const { routes } = await (await app.get(routesPath(SRC, [DST_1, DST_1]))).json();

    assert.equal(routes.length, 1);
    assert.equal(osrm.calls.length, 1);
  });

  test('A7 an integer distance (as OSRM sends it) is passed through unchanged', async (t) => {
    const { app } = await setup(t, () => reply.ok()); // real payload: "distance":1888

    const text = await (await app.get(routesPath(SRC, [DST_1]))).text();

    assert.match(text, /"distance":1888[,}]/);
  });

  test('A8 unknown query parameters are ignored', async (t) => {
    const { app } = await setup(t, () => reply.ok());

    const res = await app.get(routesPath(SRC, [DST_1], '&foo=bar'));

    assert.equal(res.status, 200);
  });
});
