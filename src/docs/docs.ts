import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Router } from 'express';
import { parse } from 'yaml';

const require = createRequire(import.meta.url);

// The parts of the spec this module and the tests read; the rest is passed through.
export interface OpenApiSpec {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, OpenApiOperation>>;
  [key: string]: unknown;
}

interface OpenApiOperation {
  responses: Record<string, OpenApiResponse>;
}

export interface OpenApiResponse {
  headers?: Record<string, unknown>;
  content?: Record<
    string,
    { example?: { error?: string }; examples?: Record<string, { value: { error?: string } }> }
  >;
}

// The spec lives in openapi.yaml; its version always follows package.json.
// Paths are relative to this file, so they resolve the same from src/ (run
// directly), dist/ (built: `pnpm build` copies openapi.yaml there) and the
// Vercel bundle. Each path is a literal inside `new URL(…, import.meta.url)`
// on purpose: that is the pattern Vercel's file tracing follows to put the
// files in the deployed function. A helper taking the path as a variable hides it.
export function loadSpec(): OpenApiSpec {
  const yaml = readFileSync(new URL('./openapi.yaml', import.meta.url), 'utf8');
  const pkg = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
  const spec = parse(yaml) as OpenApiSpec;
  spec.info.version = (JSON.parse(pkg) as { version: string }).version;
  return spec;
}

// Swagger UI's own files live under /swagger-ui/, so they never clash with API routes.
const ASSETS_PATH = '/swagger-ui';

// The swagger-ui-dist files the page loads, served by name from this list only.
// Not express.static over the package: Vercel ignores express.static, and its
// file tracing bundles only files it can see referenced. One literal
// require.resolve() per file is a reference it follows, so these four files are
// in the deployed function and served the same way locally and on Vercel.
const SWAGGER_FILES = {
  'swagger-ui.css': require.resolve('swagger-ui-dist/swagger-ui.css'),
  'favicon-32x32.png': require.resolve('swagger-ui-dist/favicon-32x32.png'),
  'swagger-ui-bundle.js': require.resolve('swagger-ui-dist/swagger-ui-bundle.js'),
  'swagger-ui-standalone-preset.js':
    require.resolve('swagger-ui-dist/swagger-ui-standalone-preset.js'),
} as const;

type SwaggerFile = keyof typeof SWAGGER_FILES;
const isSwaggerFile = (name: string): name is SwaggerFile => Object.hasOwn(SWAGGER_FILES, name);
const asset = (name: SwaggerFile): string => `${ASSETS_PATH}/${name}`;

const page = (title: string): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <link rel="stylesheet" href="${asset('swagger-ui.css')}" />
    <link rel="icon" type="image/png" href="${asset('favicon-32x32.png')}" sizes="32x32" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="${asset('swagger-ui-bundle.js')}"></script>
    <script src="${asset('swagger-ui-standalone-preset.js')}"></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: '/openapi.json',
        dom_id: '#swagger-ui',
        presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
        layout: 'StandaloneLayout',
        tryItOutEnabled: true,
      });
    </script>
  </body>
</html>
`;

// GET /docs         — Swagger UI.
// GET /openapi.json — the raw spec.
export function createDocsRouter(): Router {
  const spec = loadSpec();
  const html = page(`${spec.info.title} — API docs`);
  const router = Router();

  router.get(['/docs', '/docs/'], (_req, res) => res.type('html').send(html));
  router.get('/openapi.json', (_req, res) => res.json(spec));
  router.get(`${ASSETS_PATH}/:file`, (req, res, next) => {
    const { file } = req.params;
    if (!isSwaggerFile(file)) return next();
    // dotfiles: pnpm keeps packages under node_modules/.pnpm/, which send() would
    // otherwise refuse. Safe here: the path comes from SWAGGER_FILES, never the request.
    res.sendFile(SWAGGER_FILES[file], { maxAge: '1d', dotfiles: 'allow' });
  });

  return router;
}
