import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { createApp } from '../../src/app.js';
import { createLogger } from '../../src/utils/logger.js';
import { startOsrmStub } from './osrm-stub.js';

// Starts the app on a random port and captures its log lines.
export async function startApp(options = {}) {
  const lines = [];
  const app = createApp({
    logger: createLogger((line) => lines.push(line)),
    retryDelayMs: 0,
    ...options,
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;

  return {
    url,
    lines,
    logs: () => lines.map((line) => JSON.parse(line)),
    get: (path, init) => fetch(url + path, init),
    // The request log line is written on 'close', which can land just after the client has its response.
    async requestLog() {
      for (let i = 0; i < 50; i++) {
        const entry = this.logs().find((l) => l.msg === 'request');
        if (entry) return entry;
        await sleep(10);
      }
      throw new Error('no request log line written');
    },
    close() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

// Stub OSRM + app wired to it, both torn down after the test.
export async function setup(t, handler, options = {}) {
  const osrm = await startOsrmStub(handler);
  const app = await startApp({ osrmUrl: osrm.url, ...options });
  t.after(() => Promise.all([app.close(), osrm.close()]));
  return { osrm, app };
}

export function routesPath(src, dsts, extra = '') {
  const params = new URLSearchParams();
  if (src !== undefined) params.append('src', src);
  for (const dst of dsts) params.append('dst', dst);
  // URLSearchParams escapes ',', which Express decodes; keep it readable instead.
  return `/routes?${params.toString().replaceAll('%2C', ',')}${extra}`;
}
