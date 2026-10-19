import express from 'express';
import { randomUUID } from 'node:crypto';
import { createDocsRouter } from './docs/docs.js';
import { createRoutesRouter } from './routes/routes.js';
import { createOsrmClient } from './services/osrm.js';
import { createLogger } from './utils/logger.js';

export const DEFAULTS = {
  osrmUrl: 'http://router.project-osrm.org',
  requestTimeoutMs: 10_000, // whole request, all destinations and retries included
  attemptTimeoutMs: 4_000, // one OSRM call
  maxAttempts: 2, // one retry, for transient failures only
  retryDelayMs: 200,
  concurrency: 5, // OSRM calls in flight per request
  maxDestinations: 100,
};

const REQUEST_ID = /^[\w.-]{1,128}$/;

// Gives each request an id and writes one log line when the response closes.
// Handlers add fields to res.locals.log. The query string is never logged,
// because it holds customer coordinates.
function requestContext(logger) {
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

export function createApp(options = {}) {
  const config = { ...DEFAULTS, ...options };
  config.osrmUrl = config.osrmUrl.replace(/\/+$/, '');
  const logger = config.logger ?? createLogger();
  const osrm = createOsrmClient(config);

  const app = express();
  app.disable('x-powered-by');
  app.use(requestContext(logger));

  // Service descriptor: what this service is and where to go next.
  app.get('/', (req, res) => {
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

  app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  app.use(createDocsRouter());
  app.use('/routes', createRoutesRouter({ ...config, osrm, logger }));

  app.use((err, req, res, _next) => {
    logger.error({ msg: 'unhandled error', requestId: res.locals.requestId, error: err.stack });
    res.locals.log.outcome = 'internal_error';
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
