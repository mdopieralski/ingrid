// Process entry: reads env and starts the server. Also the entry Vercel deploys:
// its Express preset looks for src/index.ts that imports from 'express' and
// calls listen(), so keep the `Express` import below even though it is type-only.
import type { Express } from 'express';
import { createApp, DEFAULTS } from './create-app.ts';
import { createLogger } from './utils/logger.ts';

const PORT = Number(process.env.PORT) || 3000;
// Set by portless in `pnpm start:dev` (e.g. https://ingrid.local); plain localhost otherwise.
const PUBLIC_URL = process.env.PORTLESS_URL || `http://localhost:${PORT}`;
const logger = createLogger();

const app: Express = createApp({ osrmUrl: process.env.OSRM_URL || DEFAULTS.osrmUrl, logger });

app.listen(PORT, () => {
  logger.info({ msg: 'Server listening', url: PUBLIC_URL, docs: `${PUBLIC_URL}/docs` });
});
