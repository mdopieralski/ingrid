import { Router, type Response } from 'express';
import { parseCoordinate, type Coordinate } from '../utils/coordinates.ts';
import { mapWithConcurrency } from '../utils/concurrency.ts';
import {
  RoutingError,
  type OsrmClient,
  type Route,
  type RoutingErrorKind,
} from '../services/osrm.ts';
import type { Logger } from '../utils/logger.ts';
import type { Outcome } from '../create-app.ts';

// RoutingError kind → status, client message and log outcome.
// Client messages are fixed strings so upstream detail never leaks.
const FAILURES: Record<RoutingErrorKind, { status: number; error: string; outcome: Outcome }> = {
  timeout: { status: 504, error: 'Routing service timed out', outcome: 'upstream_timeout' },
  rate_limited: {
    status: 503,
    error: 'Routing service is busy, retry later',
    outcome: 'upstream_rate_limited',
  },
  unavailable: {
    status: 502,
    error: 'Routing service unavailable',
    outcome: 'upstream_unavailable',
  },
  bad_response: {
    status: 502,
    error: 'Routing service unavailable',
    outcome: 'upstream_bad_response',
  },
  rejected: { status: 500, error: 'Internal server error', outcome: 'upstream_rejected' },
  cancelled: { status: 499, error: 'Request cancelled', outcome: 'client_cancelled' },
};

// Validation messages echo the caller's own value back. Cap it: a huge query
// parameter must not drive the size of the response.
const MAX_ECHO = 50;
const echo = (value: unknown): string => {
  const text = String(value);
  return text.length > MAX_ECHO ? `${text.slice(0, MAX_ECHO)}…` : text;
};

export interface RoutesRouterOptions {
  osrm: OsrmClient;
  logger: Logger;
  concurrency: number;
  maxDestinations: number;
  requestTimeoutMs: number;
}

interface RoutesBody {
  source: Coordinate;
  routes: ({ destination: Coordinate } & Route)[];
  unroutable?: Coordinate[];
}

export function createRoutesRouter({
  osrm,
  logger,
  concurrency,
  maxDestinations,
  requestTimeoutMs,
}: RoutesRouterOptions): Router {
  const router = Router();

  // GET /routes?src=lng,lat&dst=lng,lat&dst=lng,lat...
  router.get('/', async (req, res: Response<RoutesBody | { error: string }>) => {
    const log = res.locals.log;
    const badRequest = (error: string) => {
      log.outcome = 'invalid_input';
      res.status(400).json({ error });
    };

    const { src: rawSrc, dst: rawDst } = req.query;

    if (rawSrc === undefined || Array.isArray(rawSrc)) {
      return badRequest('Exactly one "src" parameter is required');
    }
    const src = parseCoordinate(rawSrc);
    if (!src) return badRequest(`Invalid "src" coordinate: ${echo(rawSrc)}`);

    const dstList: unknown[] = rawDst === undefined ? [] : [rawDst].flat();
    if (dstList.length === 0) return badRequest('At least one "dst" parameter is required');
    if (dstList.length > maxDestinations) {
      return badRequest(`Too many "dst" parameters: ${dstList.length} (max ${maxDestinations})`);
    }
    const parsed = dstList.map(parseCoordinate);
    const invalidIndex = parsed.indexOf(null);
    if (invalidIndex !== -1) {
      return badRequest(`Invalid "dst" coordinate: ${echo(dstList[invalidIndex])}`);
    }

    // A repeated destination is routed once and listed once.
    const destinations = [...new Set(parsed as Coordinate[])];
    log.destinationCount = destinations.length;

    // One deadline for the whole request. It is cancelled early if the client
    // disconnects or another destination has already failed the request.
    const cancel = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) cancel.abort();
    });
    const signal = AbortSignal.any([AbortSignal.timeout(requestTimeoutMs), cancel.signal]);

    const started = performance.now();
    let results: (Route | null)[];
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
      const { status, error, outcome } = FAILURES[err.kind];
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

    const routes: RoutesBody['routes'] = [];
    const unroutable: Coordinate[] = [];
    destinations.forEach((destination, i) => {
      const route = results[i];
      if (route) routes.push({ destination, ...route });
      else unroutable.push(destination);
    });
    routes.sort((a, b) => a.duration - b.duration || a.distance - b.distance);

    log.outcome = 'ok';
    log.unroutableCount = unroutable.length;
    res.json(unroutable.length ? { source: src, routes, unroutable } : { source: src, routes });
  });

  return router;
}
