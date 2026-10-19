import { Router } from 'express';
import { parseCoordinate } from '../utils/coordinates.js';
import { mapWithConcurrency } from '../utils/concurrency.js';
import { RoutingError } from '../services/osrm.js';

// RoutingError kind → [status, client message, log outcome].
// Client messages are fixed strings so upstream detail never leaks.
const FAILURES = {
  timeout: [504, 'Routing service timed out', 'upstream_timeout'],
  rate_limited: [503, 'Routing service is busy, retry later', 'upstream_rate_limited'],
  unavailable: [502, 'Routing service unavailable', 'upstream_unavailable'],
  bad_response: [502, 'Routing service unavailable', 'upstream_bad_response'],
  rejected: [500, 'Internal server error', 'upstream_rejected'],
  cancelled: [499, 'Request cancelled', 'client_cancelled'],
};

// Validation messages echo the caller's own value back. Cap it: a huge query
// parameter must not drive the size of the response.
const MAX_ECHO = 50;
const echo = (value) => {
  const text = String(value);
  return text.length > MAX_ECHO ? `${text.slice(0, MAX_ECHO)}\u2026` : text;
};

export function createRoutesRouter({
  osrm,
  logger,
  concurrency,
  maxDestinations,
  requestTimeoutMs,
}) {
  const router = Router();

  // GET /routes?src=lng,lat&dst=lng,lat&dst=lng,lat...
  router.get('/', async (req, res) => {
    const log = res.locals.log;
    const badRequest = (error) => {
      log.outcome = 'invalid_input';
      return res.status(400).json({ error });
    };

    const { src: rawSrc, dst: rawDst } = req.query;

    if (rawSrc === undefined || Array.isArray(rawSrc)) {
      return badRequest('Exactly one "src" parameter is required');
    }
    const src = parseCoordinate(rawSrc);
    if (!src) return badRequest(`Invalid "src" coordinate: ${echo(rawSrc)}`);

    const dstList = rawDst === undefined ? [] : [rawDst].flat();
    if (dstList.length === 0) return badRequest('At least one "dst" parameter is required');
    if (dstList.length > maxDestinations) {
      return badRequest(`Too many "dst" parameters: ${dstList.length} (max ${maxDestinations})`);
    }
    const parsed = dstList.map(parseCoordinate);
    const invalidIndex = parsed.indexOf(null);
    if (invalidIndex !== -1)
      return badRequest(`Invalid "dst" coordinate: ${echo(dstList[invalidIndex])}`);

    // A repeated destination is routed once and listed once.
    const destinations = [...new Set(parsed)];
    log.destinationCount = destinations.length;

    // One deadline for the whole request. It is cancelled early if the client
    // disconnects or another destination has already failed the request.
    const cancel = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) cancel.abort();
    });
    const signal = AbortSignal.any([AbortSignal.timeout(requestTimeoutMs), cancel.signal]);

    const started = performance.now();
    let results;
    try {
      results = await mapWithConcurrency(destinations, concurrency, async (dst) => {
        try {
          return await osrm.getRoute(src, dst, { signal });
        } catch (err) {
          cancel.abort();
          throw err;
        }
      });
    } catch (err) {
      if (!(err instanceof RoutingError)) throw err;
      const [status, error, outcome] = FAILURES[err.kind];
      log.outcome = outcome;
      logger[status === 500 ? 'error' : 'warn']({
        msg: 'upstream request failed',
        requestId: res.locals.requestId,
        kind: err.kind,
        detail: err.message,
      });
      if (err.retryAfter) res.set('Retry-After', err.retryAfter);
      return res.status(status).json({ error });
    } finally {
      log.upstreamLatencyMs = Math.round(performance.now() - started);
    }

    const routes = [];
    const unroutable = [];
    destinations.forEach((destination, i) => {
      if (results[i]) routes.push({ destination, ...results[i] });
      else unroutable.push(destination);
    });
    routes.sort((a, b) => a.duration - b.duration || a.distance - b.distance);

    log.outcome = 'ok';
    log.unroutableCount = unroutable.length;
    res.json(unroutable.length ? { source: src, routes, unroutable } : { source: src, routes });
  });

  return router;
}
