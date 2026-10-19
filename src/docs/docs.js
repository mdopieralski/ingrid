import { readFileSync } from 'node:fs';
import express, { Router } from 'express';
import { getAbsoluteFSPath } from 'swagger-ui-dist';
import { parse } from 'yaml';

const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');

// The spec lives in openapi.yaml; its version always follows package.json.
export function loadSpec() {
  const spec = parse(read('./openapi.yaml'));
  spec.info.version = JSON.parse(read('../../package.json')).version;
  return spec;
}

// Swagger UI's own files live under /swagger-ui/, so they never clash with API routes.
const ASSETS = '/swagger-ui';

const page = (title) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <link rel="stylesheet" href="${ASSETS}/swagger-ui.css" />
    <link rel="icon" type="image/png" href="${ASSETS}/favicon-32x32.png" sizes="32x32" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="${ASSETS}/swagger-ui-bundle.js"></script>
    <script src="${ASSETS}/swagger-ui-standalone-preset.js"></script>
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
export function createDocsRouter() {
  const spec = loadSpec();
  const html = page(`${spec.info.title} — API docs`);
  const router = Router();

  router.get(['/docs', '/docs/'], (req, res) => res.type('html').send(html));
  router.get('/openapi.json', (req, res) => res.json(spec));
  router.use(ASSETS, express.static(getAbsoluteFSPath(), { index: false }));

  return router;
}
