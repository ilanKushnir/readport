import { createRequire } from 'node:module';

/** The server's own version, from its package.json: "0.12.0". */
export const APP_VERSION: string = (
  createRequire(import.meta.url)('../../package.json') as { version: string }
).version;
