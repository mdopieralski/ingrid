import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';

// A local HTTP server standing in for OSRM. `handler(call)` returns
// { status, body, headers, delayMs, hang }. `body` is JSON-encoded unless
// it is a string. `hang: true` never answers.
// `call` = { dst, attempt, aborted }, where attempt counts calls for that dst.
export async function startOsrmStub(handler) {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const server = http.createServer(async (req, res) => {
    const [, src, dst] = req.url.match(/^\/route\/v1\/driving\/([^;]+);([^?]+)/) ?? [];
    const call = {
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
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    callsFor: (dst) => calls.filter((c) => c.dst === dst),
    get inFlight() {
      return inFlight;
    },
    get maxInFlight() {
      return maxInFlight;
    },
    close() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

// A URL where nothing listens: bind a port, then release it.
export async function unusedUrl() {
  const server = http.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}`;
}
