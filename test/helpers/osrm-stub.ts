import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';

// One request the stub received. `attempt` counts calls for that dst.
export interface StubCall {
  src: string | undefined;
  dst: string | undefined;
  attempt: number;
  aborted: boolean;
}

// What the stub sends back. `body` is JSON-encoded unless it is a string.
// `hang: true` never answers.
export interface StubReply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  delayMs?: number;
  hang?: boolean;
}

export type StubHandler = (
  call: StubCall,
) => StubReply | undefined | Promise<StubReply | undefined>;

export interface OsrmStub {
  url: string;
  calls: StubCall[];
  callsFor(dst: string): StubCall[];
  readonly inFlight: number;
  readonly maxInFlight: number;
  close(): Promise<void>;
}

async function listen(server: http.Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export function closeServer(server: http.Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

// A local HTTP server standing in for OSRM.
export async function startOsrmStub(handler: StubHandler): Promise<OsrmStub> {
  const calls: StubCall[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const server = http.createServer((req, res) => {
    void (async () => {
      const [, src, dst] = req.url?.match(/^\/route\/v1\/driving\/([^;]+);([^?]+)/) ?? [];
      const call: StubCall = {
        src,
        dst,
        attempt: calls.filter((c) => c.dst === dst).length + 1,
        aborted: false,
      };
      calls.push(call);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      res.on('close', () => {
        inFlight--;
        if (!res.writableFinished) call.aborted = true;
      });

      const reply = (await handler(call)) ?? {};
      if (reply.hang) return;
      if (reply.delayMs) await sleep(reply.delayMs);
      if (res.destroyed) return;
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json', ...reply.headers });
      res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {}));
    })();
  });

  const url = await listen(server);

  return {
    url,
    calls,
    callsFor: (dst) => calls.filter((c) => c.dst === dst),
    get inFlight() {
      return inFlight;
    },
    get maxInFlight() {
      return maxInFlight;
    },
    close: () => closeServer(server),
  };
}

// A URL where nothing listens: bind a port, then release it.
export async function unusedUrl(): Promise<string> {
  const server = http.createServer();
  const url = await listen(server);
  await closeServer(server);
  return url;
}
