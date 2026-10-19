import { setTimeout as sleep } from 'node:timers/promises';

// OSRM's way of saying "no road connects these points". This is a valid answer,
// not an outage. OSRM sends these with HTTP 400, so `code` is checked before the status.
const UNROUTABLE_CODES = new Set(['NoRoute', 'NoSegment']);

// `kind` decides the HTTP status the route handler returns.
// `message` is upstream detail: it goes to logs only, never to the client.
export class RoutingError extends Error {
  constructor(kind, message, { retryable = false, retryAfter } = {}) {
    super(message);
    this.name = 'RoutingError';
    this.kind = kind;
    this.retryable = retryable;
    this.retryAfter = retryAfter;
  }
}

// `signal` is the request-wide signal (deadline or cancellation).
function abortedError(signal) {
  return signal.reason?.name === 'TimeoutError'
    ? new RoutingError('timeout', 'request deadline exceeded')
    : new RoutingError('cancelled', 'request cancelled');
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function createOsrmClient({ osrmUrl, attemptTimeoutMs, maxAttempts, retryDelayMs }) {
  async function attempt(src, dst, signal) {
    const url = `${osrmUrl}/route/v1/driving/${src};${dst}?overview=false`;
    const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(attemptTimeoutMs)]);

    let response, text;
    try {
      response = await fetch(url, { signal: attemptSignal });
      text = await response.text();
    } catch (err) {
      if (signal.aborted) throw abortedError(signal);
      if (err.name === 'TimeoutError') {
        throw new RoutingError('timeout', `no response within ${attemptTimeoutMs} ms`, {
          retryable: true,
        });
      }
      throw new RoutingError('unavailable', `transport error: ${err.cause?.code ?? err.message}`, {
        retryable: true,
      });
    }

    const body = parseJson(text);
    const upstream = `HTTP ${response.status} ${body?.code ?? ''} ${body?.message ?? ''}`.trim();

    if (UNROUTABLE_CODES.has(body?.code)) return null;
    if (response.status === 429) {
      throw new RoutingError('rate_limited', upstream, {
        retryAfter: response.headers.get('retry-after') ?? undefined,
      });
    }
    if (response.status >= 500)
      throw new RoutingError('unavailable', upstream, { retryable: true });
    // Any other 4xx (InvalidQuery, InvalidUrl, ...) means we built a bad request: our bug.
    if (!response.ok) throw new RoutingError('rejected', upstream);
    if (body === null) throw new RoutingError('bad_response', `${upstream}: body is not JSON`);
    if (body.code !== 'Ok') throw new RoutingError('bad_response', `unexpected code: ${upstream}`);

    const route = body.routes?.[0];
    if (!Number.isFinite(route?.duration) || !Number.isFinite(route?.distance)) {
      throw new RoutingError('bad_response', `${upstream}: no route with duration and distance`);
    }
    return { duration: route.duration, distance: route.distance };
  }

  // Returns { duration, distance } of the fastest driving route, or null if no
  // road connects the points. Retries only transient failures (5xx, timeout,
  // transport), and never past the request deadline carried by `signal`.
  async function getRoute(src, dst, { signal }) {
    for (let attemptNo = 1; ; attemptNo++) {
      try {
        return await attempt(src, dst, signal);
      } catch (err) {
        if (!err.retryable || attemptNo >= maxAttempts) throw err;
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
