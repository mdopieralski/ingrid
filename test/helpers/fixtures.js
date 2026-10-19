import { readFileSync } from 'node:fs';

// Real OSRM payloads, see test/fixtures/README.md.
export function fixture(name) {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'));
}

// Stub replies built from the real payloads, with the HTTP status OSRM really uses.
export const reply = {
  ok: () => ({ status: 200, body: fixture('route-ok') }),
  ok2: () => ({ status: 200, body: fixture('route-ok-2') }),
  noRoute: () => ({ status: 400, body: fixture('route-no-route') }),
  noSegment: () => ({ status: 400, body: fixture('route-no-segment') }),
  invalidQuery: () => ({ status: 400, body: fixture('route-invalid-query') }),
  invalidOptions: () => ({ status: 400, body: fixture('route-invalid-options') }),
};

// The real "Ok" payload with only duration/distance replaced.
export function okWith({ duration, distance }) {
  const body = fixture('route-ok');
  Object.assign(body.routes[0], { duration, distance });
  Object.assign(body.routes[0].legs[0], { duration, distance });
  return { status: 200, body };
}

// The brief's coordinates.
export const SRC = '13.388860,52.517037';
export const DST_1 = '13.397634,52.529407';
export const DST_2 = '13.428555,52.523219';
