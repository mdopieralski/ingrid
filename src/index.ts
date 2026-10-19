import { createApp, DEFAULTS } from './app.ts';
import { createLogger } from './utils/logger.ts';

const PORT = Number(process.env.PORT) || 3000;
// Set by portless in `pnpm start:dev` (e.g. https://ingrid.local); plain localhost otherwise.
const PUBLIC_URL = process.env.PORTLESS_URL || `http://localhost:${PORT}`;
const logger = createLogger();

const app = createApp({ osrmUrl: process.env.OSRM_URL || DEFAULTS.osrmUrl, logger });

app.listen(PORT, () => {
  logger.info({ msg: 'Server listening', url: PUBLIC_URL, docs: `${PUBLIC_URL}/docs` });
});
