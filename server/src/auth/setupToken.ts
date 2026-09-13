import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { type EnvConfig } from '../config.js';
import { type DB } from '../db/index.js';

/**
 * Optional first-run bootstrap lock.
 *
 * By default there is NO token: you start the container, open it, and create
 * your admin account. That is what first-run should feel like, and copying a
 * random string out of `docker logs` to get past your own welcome screen is
 * friction for the owner, not for an attacker - the window it protects is the
 * seconds between a container starting and its owner opening it.
 *
 * It is not nothing, though: while an instance is empty, whoever completes
 * the wizard owns it. Anyone who will have that window open on a hostile
 * network - a public URL with no gate in front, a shared host - sets
 * RP_SETUP_TOKEN (or RP_SETUP_TOKEN_FILE) and the wizard demands it. A token
 * is never generated, so "no token configured" always means "open", and the
 * server says so in the log rather than letting it be a surprise.
 *
 * Either way the door closes for good the moment an admin exists: /api/setup
 * answers 409 from then on.
 */

export interface SetupTokenHandle {
  source: 'env';
  matches(candidate: string): boolean;
  /** Permanently disable the token (first admin exists now). */
  consume(): void;
}

function hashed(v: string): Buffer {
  return createHash('sha256').update(v, 'utf8').digest();
}

export function ensureSetupToken(
  config: Pick<EnvConfig, 'dataDir' | 'setupToken'>,
  db: DB,
  log: { info: (m: string) => void; warn: (m: string) => void },
): SetupTokenHandle | null {
  // Older versions generated a token here and wrote it to this file. Remove
  // it on sight: leaving it behind would have an operator typing a token the
  // server no longer knows about.
  fs.rmSync(path.join(config.dataDir, 'setup-token'), { force: true });

  const users = (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
  if (users > 0) return null;

  if (!config.setupToken) {
    log.warn(
      'First-run setup is OPEN: whoever reaches this server first creates the admin account.\n' +
        '    Finish setup now, or set RP_SETUP_TOKEN to require a token.',
    );
    return null;
  }

  log.info('First-run setup is locked with RP_SETUP_TOKEN.');
  let consumed = false;
  let expected: Buffer | null = hashed(config.setupToken);
  return {
    source: 'env',
    matches(candidate: string): boolean {
      if (consumed || !expected || !candidate) return false;
      return timingSafeEqual(hashed(candidate), expected);
    },
    consume(): void {
      consumed = true;
      expected = null;
    },
  };
}
