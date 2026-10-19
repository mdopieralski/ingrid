import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import { setup, startApp, routesPath } from './helpers/app.ts';
import { unusedUrl, type StubHandler } from './helpers/osrm-stub.ts';
import { reply, SRC, DST_1, DST_2 } from './helpers/fixtures.ts';
import { loadSpec, type OpenApiResponse, type OpenApiSpec } from '../src/docs/docs.ts';

const spec = loadSpec();
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

// Validates bodies against the spec's own schemas, so the docs cannot drift from the code.
const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema(spec, 'spec');
const schema = (name: string): ValidateFunction =>
  ajv.compile({ $ref: `spec#/components/schemas/${name}` });

function documented(path: string, status: number): OpenApiResponse {
  const response = spec.paths[path]?.get?.responses[String(status)];
  assert.ok(response, `${path} ${status} is not documented`);
  return response;
}

// Every message a documented response lists in its examples.
function documentedMessages(path: string, status: number): (string | undefined)[] {
  const content = documented(path, status).content?.['application/json'];
  assert.ok(content, `${path} ${status} documents no JSON body`);
  return content.example
    ? [content.example.error]
    : Object.values(content.examples ?? {}).map((e) => e.value.error);
}

function assertValid(validate: ValidateFunction, body: unknown): void {
  assert.ok(validate(body), JSON.stringify(validate.errors));
}

describe('F. API docs match the API', () => {
  test('F1 GET /openapi.json serves the spec, versioned from package.json', async (t) => {
    const { app } = await setup(t, () => reply.ok());

    const res = await app.get('/openapi.json');
    const body = (await res.json()) as unknown as OpenApiSpec;

    assert.equal(res.status, 200);
    assert.equal(body.openapi, '3.1.0');
    assert.equal(body.info.version, pkg.version);
    assert.deepEqual(Object.keys(body.paths).sort(), ['/', '/health', '/routes']);
  });

  test('F2 GET /docs serves Swagger UI pointed at /openapi.json, with every asset it loads', async (t) => {
    const { app } = await setup(t, () => reply.ok());

    assert.equal((await app.get('/docs/')).status, 200);
    const res = await app.get('/docs');
    const html = await res.text();

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    assert.match(html, /SwaggerUIBundle\(/);
    assert.match(html, /url: '\/openapi\.json'/);
    const assets = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1] ?? '');
    assert.ok(assets.length >= 3, `assets: ${assets.join(', ')}`);
    for (const asset of assets) {
      assert.equal((await app.get(asset)).status, 200, `asset ${asset}`);
    }
  });

  test('F3 / and /health match their schemas', async (t) => {
    const { app } = await setup(t, () => reply.ok());

    assertValid(schema('ServiceDescriptor'), await (await app.get('/')).json());
    assertValid(schema('Health'), await (await app.get('/health')).json());
  });

  test('F4 a 200 with routes matches RoutesResponse and the documented example', async (t) => {
    const { app } = await setup(t, ({ dst }) => (dst === DST_1 ? reply.ok() : reply.ok2()));

    const res = await app.get(routesPath(SRC, [DST_1, DST_2]));
    const body = await res.json();

    assert.equal(res.status, 200);
    assertValid(schema('RoutesResponse'), body);
    const examples = documented('/routes', 200).content?.['application/json']?.examples;
    assert.deepEqual(body, examples?.twoDestinations?.value);
  });

  test('F5 a 200 with unroutable matches RoutesResponse', async (t) => {
    const { app } = await setup(t, ({ dst }) => (dst === DST_2 ? reply.noRoute() : reply.ok()));

    const body = await (await app.get(routesPath(SRC, [DST_1, DST_2]))).json();

    assertValid(schema('RoutesResponse'), body);
    assert.deepEqual(body.unroutable, [DST_2]);
  });

  describe('F6 every 400 message is one the docs list', () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => `13.${String(i).padStart(4, '0')},52.5`);
    const cases: [name: string, path: string][] = [
      ['src missing', routesPath(undefined, [DST_1])],
      ['src repeated', `/routes?src=${SRC}&src=${SRC}&dst=${DST_1}`],
      ['src invalid', routesPath('200.0,52.5', [DST_1])],
      ['dst missing', routesPath(SRC, [])],
      ['dst too many', routesPath(SRC, many(101))],
      ['dst invalid', routesPath(SRC, ['abc,def'])],
    ];
    const messages = documentedMessages('/routes', 400);

    for (const [name, path] of cases) {
      test(name, async (t) => {
        const { app } = await setup(t, () => reply.ok());

        const res = await app.get(path);
        const body = await res.json();

        assert.equal(res.status, 400);
        assertValid(schema('Error'), body);
        assert.ok(messages.includes(body.error), `undocumented message: ${body.error}`);
      });
    }
  });

  describe('F7 every 5xx status and message is the documented one', () => {
    const FAST = { attemptTimeoutMs: 100, requestTimeoutMs: 1000 };
    const cases: [status: number, handler: StubHandler][] = [
      [500, () => reply.invalidQuery()],
      [502, () => ({ status: 503 })],
      [503, () => ({ status: 429, headers: { 'Retry-After': '30' } })],
      [504, () => ({ hang: true })],
    ];

    for (const [status, handler] of cases) {
      test(String(status), async (t) => {
        const { app } = await setup(t, handler, FAST);

        const res = await app.get(routesPath(SRC, [DST_1]));
        const body = await res.json();

        assert.equal(res.status, status);
        assertValid(schema('Error'), body);
        assert.deepEqual(documentedMessages('/routes', status), [body.error]);
        for (const header of Object.keys(documented('/routes', status).headers ?? {})) {
          assert.ok(res.headers.has(header), `documented header ${header} is missing`);
        }
      });
    }

    test('502 for connection refused too', async (t) => {
      const app = await startApp({ osrmUrl: await unusedUrl() });
      t.after(() => app.close());

      const res = await app.get(routesPath(SRC, [DST_1]));

      assert.equal(res.status, 502);
      assert.deepEqual(documentedMessages('/routes', 502), [(await res.json()).error]);
    });
  });

  test('F8 the documented X-Request-Id pattern is the one the app accepts', async (t) => {
    const { app } = await setup(t, () => reply.ok());
    const components = spec.components as {
      parameters: { RequestId: { schema: { pattern: string } } };
    };
    const pattern = new RegExp(components.parameters.RequestId.schema.pattern);

    for (const id of ['abc-123', 'a.b_c', 'x'.repeat(128), 'x'.repeat(129), 'has space', 'ü']) {
      const res = await app.get('/health', { headers: { 'X-Request-Id': encodeURI(id) } });
      const kept = res.headers.get('x-request-id') === encodeURI(id);
      assert.equal(kept, pattern.test(encodeURI(id)), `id ${id}`);
    }
  });
});
