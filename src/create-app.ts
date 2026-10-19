import express, { type ErrorRequestHandler, type Express, type RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { createDocsRouter } from './docs/docs.ts';
import { createRoutesRouter } from './routes/routes.ts';
import { createOsrmClient } from './services/osrm.ts';
import { createLogger, type Logger } from './utils/logger.ts';

export const DEFAULTS = {
  osrmUrl: 'http://router.project-osrm.org',
  requestTimeoutMs: 10_000, // whole request, all destinations and retries included
  attemptTimeoutMs: 4_000, // one OSRM call
  maxAttempts: 2, // one retry, for transient failures only
  retryDelayMs: 200,
  concurrency: 5, // OSRM calls in flight per request
  maxDestinations: 100,
};

export type AppConfig = typeof DEFAULTS;
export type AppOptions = Partial<AppConfig> & { logger?: Logger };

// `outcome` on the request log line: what happened, in one word.
export type Outcome =
  | 'ok'
  | 'invalid_input'
  | 'upstream_timeout'
  | 'upstream_rate_limited'
  | 'upstream_unavailable'
  | 'upstream_bad_response'
  | 'upstream_rejected'
  | 'client_cancelled'
  | 'internal_error';

// Fields handlers add to the request's log line.
export interface RequestLog {
  outcome?: Outcome;
  destinationCount?: number;
  upstreamLatencyMs?: number;
  unroutableCount?: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Express's own extension point
  namespace Express {
    interface Locals {
      requestId: string;
      log: RequestLog;
    }
  }
}

const REQUEST_ID = /^[\w.-]{1,128}$/;

// Gives each request an id and writes one log line when the response closes.
// Handlers add fields to res.locals.log. The query string is never logged,
// because it holds customer coordinates.
function requestContext(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const incoming = req.get('x-request-id');
    const requestId = incoming && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    const started = performance.now();
    const { method, path } = req; // read now: routers rewrite req.url later

    res.locals.requestId = requestId;
    res.locals.log = {};
    res.set('X-Request-Id', requestId);
    res.on('close', () => {
      // Not finished on close means the client went away before the response was sent.
      const cancelled = !res.writableFinished;
      logger.info({
        msg: 'request',
        requestId,
        method,
        path,
        status: cancelled ? 499 : res.statusCode,
        durationMs: Math.round(performance.now() - started),
        ...res.locals.log,
        ...(cancelled && { outcome: 'client_cancelled' }),
      });
    });
    next();
  };
}

export function createApp(options: AppOptions = {}): Express {
  const { logger = createLogger(), ...overrides } = options;
  const config: AppConfig = { ...DEFAULTS, ...overrides };
  config.osrmUrl = config.osrmUrl.replace(/\/+$/, '');
  const osrm = createOsrmClient(config);

  const app = express();
  app.disable('x-powered-by');
  app.use(requestContext(logger));

  // Service descriptor: what this service is and where to go next.
  app.get('/', (_req, res) => {
    res.json({
      service: 'ingrid-routes',
      endpoints: {
        health: '/health',
        routes: '/routes?src=lng,lat&dst=lng,lat',
        docs: '/docs',
        openapi: '/openapi.json',
      },
    });
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use(createDocsRouter());
  app.use('/routes', createRoutesRouter({ ...config, osrm, logger }));

  const onError: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
    logger.error({
      msg: 'unhandled error',
      requestId: res.locals.requestId,
      error: err instanceof Error ? err.stack : String(err),
    });
    res.locals.log.outcome = 'internal_error';
    res.status(500).json({ error: 'Internal server error' });
  };
  app.use(onError);

  return app;
}
