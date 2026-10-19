// Copies the Swagger UI files the /docs page loads into public/swagger-ui/.
// Vercel serves public/ from its CDN and ignores express.static, so without
// this /docs would load on Vercel but without its CSS and JS. Run by `pnpm build`.
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { getAbsoluteFSPath } from 'swagger-ui-dist';
import { ASSETS_PATH, SWAGGER_ASSETS } from '../src/docs/docs.ts';

const target = join('public', ASSETS_PATH);
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
for (const name of SWAGGER_ASSETS)
  copyFileSync(join(getAbsoluteFSPath(), name), join(target, name));
console.log(`Copied ${SWAGGER_ASSETS.length} Swagger UI files to ${target}/`);
