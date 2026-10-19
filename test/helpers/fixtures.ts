import { readFileSync } from 'node:fs';
import type { StubReply } from './osrm-stub.ts';

// The shape of the captured OSRM payloads, as far as tests touch it.
interface OsrmPayload {
  code: string;
  routes: { duration: number; distance: number; legs: { duration: number; distance: number }[] }[];
}

// Real OSRM payloads, see test/fixtures/README.md.
export function fixture(name: string): OsrmPayload {
  const path = new URL(`../fixtures/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(path, 'utf8')) as OsrmPayload;
}

// Stub replies built from the real payloads, with the HTTP status OSRM really uses.
export const reply = {
  ok: (): StubReply => ({ status: 200, body: fixture('route-ok') }),
  ok2: (): StubReply => ({ status: 200, body: fixture('route-ok-2') }),
  noRoute: (): StubReply => ({ status: 400, body: fixture('route-no-route') }),
  noSegment: (): StubReply => ({ status: 400, body: fixture('route-no-segment') }),
  invalidQuery: (): StubReply => ({ status: 400, body: fixture('route-invalid-query') }),
  invalidOptions: (): StubReply => ({ status: 400, body: fixture('route-invalid-options') }),
};

// The real "Ok" payload with only duration/distance replaced.
export function okWith({ duration, distance }: { duration: number; distance: number }): StubReply {
  const body = fixture('route-ok');
  const [route] = body.routes;
  if (!route?.legs[0]) throw new Error('route-ok.json has no route with a leg');
  Object.assign(route, { duration, distance });
  Object.assign(route.legs[0], { duration, distance });
  return { status: 200, body };
}

// The brief's coordinates.
export const SRC = '13.388860,52.517037';
export const DST_1 = '13.397634,52.529407';
export const DST_2 = '13.428555,52.523219';
