import { setTimeout as sleep } from 'node:timers/promises';
import type { Coordinate } from '../utils/coordinates.ts';

// OSRM's way of saying "no road connects these points". This is a valid answer,
// not an outage. OSRM sends these with HTTP 400, so `code` is checked before the status.
const UNROUTABLE_CODES = new Set(['NoRoute', 'NoSegment']);

export interface Route {
  duration: number; // seconds
  distance: number; // metres
}

export interface OsrmClientOptions {
  osrmUrl: string;
  attemptTimeoutMs: number;
  maxAttempts: number;
  retryDelayMs: number;
}

export interface OsrmClient {
  getRoute(
    src: Coordinate,
    dst: Coordinate,
    options: { signal: AbortSignal },
  ): Promise<Route | null>;
}

// What the route handler maps to an HTTP status.
export type RoutingErrorKind =
  'timeout' | 'rate_limited' | 'unavailable' | 'bad_response' | 'rejected' | 'cancelled';

// `kind` decides the HTTP status the route handler returns.
// `message` is upstream detail: it goes to logs only, never to the client.
export class RoutingError extends Error {
  override readonly name = 'RoutingError';
  readonly kind: RoutingErrorKind;
  readonly retryable: boolean;
  readonly retryAfter: string | undefined;

  constructor(
    kind: RoutingErrorKind,
    message: string,
    { retryable = false, retryAfter }: { retryable?: boolean; retryAfter?: string } = {},
  ) {
    super(message);
    this.kind = kind;
    this.retryable = retryable;
    this.retryAfter = retryAfter;
  }
}

// The parts of an OSRM /route reply we read. Everything is optional: the body
// comes from the network and is checked field by field.
interface OsrmReply {
  code?: unknown;
  message?: unknown;
  routes?: { duration?: unknown; distance?: unknown }[];
}

// `signal` is the request-wide signal (deadline or cancellation).
function abortedError(signal: AbortSignal): RoutingError {
  const reason: unknown = signal.reason;
  return reason instanceof Error && reason.name === 'TimeoutError'
    ? new RoutingError('timeout', 'request deadline exceeded')
    : new RoutingError('cancelled', 'request cancelled');
}

function parseJson(text: string): OsrmReply | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null ? value : null;
  } catch {
    return null;
  }
}

function transportDetail(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const code = (err.cause as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : err.message;
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

export function createOsrmClient({
  osrmUrl,
  attemptTimeoutMs,
  maxAttempts,
  retryDelayMs,
}: OsrmClientOptions): OsrmClient {
  async function attempt(
    src: Coordinate,
    dst: Coordinate,
    signal: AbortSignal,
  ): Promise<Route | null> {
    const url = `${osrmUrl}/route/v1/driving/${src};${dst}?overview=false`;
    const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(attemptTimeoutMs)]);

    let response: Response;
    let text: string;
    try {
      response = await fetch(url, { signal: attemptSignal });
      text = await response.text();
    } catch (err) {
      if (signal.aborted) throw abortedError(signal);
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new RoutingError('timeout', `no response within ${attemptTimeoutMs} ms`, {
          retryable: true,
        });
      }
      throw new RoutingError('unavailable', `transport error: ${transportDetail(err)}`, {
        retryable: true,
      });
    }

    const body = parseJson(text);
    const code = typeof body?.code === 'string' ? body.code : '';
    const message = typeof body?.message === 'string' ? body.message : '';
    const upstream = `HTTP ${response.status} ${code} ${message}`.trim();

    if (UNROUTABLE_CODES.has(code)) return null;
    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after');
      throw new RoutingError('rate_limited', upstream, retryAfter ? { retryAfter } : {});
    }
    if (response.status >= 500)
      throw new RoutingError('unavailable', upstream, { retryable: true });
    // Any other 4xx (InvalidQuery, InvalidUrl, ...) means we built a bad request: our bug.
    if (!response.ok) throw new RoutingError('rejected', upstream);
    if (body === null) throw new RoutingError('bad_response', `${upstream}: body is not JSON`);
    if (code !== 'Ok') throw new RoutingError('bad_response', `unexpected code: ${upstream}`);

    const route = Array.isArray(body.routes) ? body.routes[0] : undefined;
    if (!isFiniteNumber(route?.duration) || !isFiniteNumber(route?.distance)) {
      throw new RoutingError('bad_response', `${upstream}: no route with duration and distance`);
    }
    return { duration: route.duration, distance: route.distance };
  }

  // Returns { duration, distance } of the fastest driving route, or null if no
  // road connects the points. Retries only transient failures (5xx, timeout,
  // transport), and never past the request deadline carried by `signal`.
  async function getRoute(
    src: Coordinate,
    dst: Coordinate,
    { signal }: { signal: AbortSignal },
  ): Promise<Route | null> {
    for (let attemptNo = 1; ; attemptNo++) {
      try {
        return await attempt(src, dst, signal);
      } catch (err) {
        if (!(err instanceof RoutingError) || !err.retryable || attemptNo >= maxAttempts) throw err;
      }
      try {
        await sleep(retryDelayMs, undefined, { signal });
      } catch {
        throw abortedError(signal);
      }
    }
  }

  return { getRoute };
}
