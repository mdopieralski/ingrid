import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TestContext } from 'node:test';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { createApp, type AppOptions } from '../../src/create-app.ts';
import { createLogger } from '../../src/utils/logger.ts';
import { closeServer, startOsrmStub, type OsrmStub, type StubHandler } from './osrm-stub.ts';

// A parsed log line: the fields tests read, plus whatever else was logged.
export interface LogLine {
  msg?: string;
  level?: string;
  requestId?: string;
  detail?: string;
  outcome?: string;
  [key: string]: unknown;
}

export interface RouteEntry {
  destination: string;
  duration: number;
  distance: number;
}

// Any body the API sends, loosely typed: the fields tests read most are typed,
// the rest is open. The assertions are the real check.
export interface ApiBody {
  source: string;
  routes: RouteEntry[];
  unroutable?: string[];
  error: string;
  [key: string]: unknown;
}

// fetch's Response, with json() returning ApiBody instead of unknown.
export interface TestResponse extends Omit<Response, 'json'> {
  json(): Promise<ApiBody>;
}

export interface TestApp {
  url: string;
  lines: string[];
  logs(): LogLine[];
  get(path: string, init?: RequestInit): Promise<TestResponse>;
  requestLog(): Promise<LogLine>;
  close(): Promise<void>;
}

// Starts the app on a random port and captures its log lines.
export async function startApp(options: AppOptions = {}): Promise<TestApp> {
  const lines: string[] = [];
  const app = createApp({
    logger: createLogger((line) => lines.push(line)),
    retryDelayMs: 0,
    ...options,
  });
  const server: Server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const logs = () => lines.map((line) => JSON.parse(line) as LogLine);

  return {
    url,
    lines,
    logs,
    get: (path, init) => fetch(url + path, init) as Promise<TestResponse>,
    // The request log line is written on 'close', which can land just after the client has its response.
    async requestLog() {
      for (let i = 0; i < 50; i++) {
        const entry = logs().find((l) => l.msg === 'request');
        if (entry) return entry;
        await sleep(10);
      }
      throw new Error('no request log line written');
    },
    close: () => closeServer(server),
  };
}

// Stub OSRM + app wired to it, both torn down after the test.
export async function setup(
  t: TestContext,
  handler: StubHandler,
  options: AppOptions = {},
): Promise<{ osrm: OsrmStub; app: TestApp }> {
  const osrm = await startOsrmStub(handler);
  const app = await startApp({ osrmUrl: osrm.url, ...options });
  t.after(() => Promise.all([app.close(), osrm.close()]));
  return { osrm, app };
}

export function routesPath(src: string | undefined, dsts: readonly string[], extra = ''): string {
  const params = new URLSearchParams();
  if (src !== undefined) params.append('src', src);
  for (const dst of dsts) params.append('dst', dst);
  // URLSearchParams escapes ',', which Express decodes; keep it readable instead.
  return `/routes?${params.toString().replaceAll('%2C', ',')}${extra}`;
}
