import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../../config.js';
import { openMemoryDatabase } from '../../db/index.js';
import { archiveName } from './library.js';

/** An audiobook's files as one ZIP, for the people allowed to take a copy. */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-archive-'));
const db = openMemoryDatabase();
const app = buildApp({
  db,
  config: loadConfig({
    dataDir: tmp,
    cacheDir: tmp,
    sessionSecret: 'archive-test-secret-0123456789abcdef',
    logLevel: 'error',
    proxyAuthHeader: 'x-rp-test-user',
    proxyAuthSources: ['10.0.0.0/8'],
  }),
  log: { info() {}, warn() {}, error() {} },
});
const as = (user: string, url: string) =>
  app.inject({ url, remoteAddress: '10.0.0.5', headers: { 'x-rp-test-user': user } });

beforeAll(async () => {
  await app.ready();
  const now = new Date().toISOString();
  fs.mkdirSync(path.join(tmp, 'Varenne', 'disc 1'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'Varenne', 'disc 2'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'Varenne', 'disc 1', 'track.mp3'), Buffer.alloc(5000, 1));
  fs.writeFileSync(path.join(tmp, 'Varenne', 'disc 2', 'track.mp3'), Buffer.alloc(7000, 2));
  db.prepare(
    `INSERT INTO books (id,kind,root_dir,rel_path,format,title,author,scan_state,added_at)
     VALUES ('kites','audio',?,'Varenne','mp3','Seventeen Kites: Over Varenne','Ilse Marrowdale','ready',?),
            ('epub','ebook',?,'x.epub','epub','An Ebook',NULL,'ready',?)`,
  ).run(tmp, now, tmp, now);
  db.prepare(
    `INSERT INTO audio_tracks (book_id,idx,rel_path,format,duration_ms,start_ms_absolute,size_bytes)
     VALUES ('kites',0,'Varenne/disc 1/track.mp3','mp3',1000,0,5000),
            ('kites',1,'Varenne/disc 2/track.mp3','mp3',1000,1000,7000)`,
  ).run();
  await as('astra', '/api/auth/me'); // the first through the proxy is the admin
  await as('dana', '/api/auth/me');
});
afterAll(async () => {
  await app.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('GET /api/books/:id/archive', () => {
  it('sends every file, in play order, in a folder named for the book, at the promised length', async () => {
    const res = await as('astra', '/api/books/kites/archive');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toContain(
      'Seventeen Kites Over Varenne - Ilse Marrowdale.zip',
    );
    const body = res.rawPayload;
    expect(Number(res.headers['content-length'])).toBe(body.length);
    const eocd = body.length - 22;
    expect(body.readUInt16LE(eocd + 10)).toBe(2);
    const names: string[] = [];
    let at = body.readUInt32LE(eocd + 16);
    for (let i = 0; i < 2; i++) {
      const len = body.readUInt16LE(at + 28);
      names.push(body.subarray(at + 46, at + 46 + len).toString('utf8'));
      at += 46 + len + body.readUInt16LE(at + 30);
    }
    expect(names).toEqual([
      'Seventeen Kites Over Varenne - Ilse Marrowdale/track.mp3',
      'Seventeen Kites Over Varenne - Ilse Marrowdale/002 track.mp3',
    ]);
  });

  it('is for people who may take a copy, and only of an audiobook', async () => {
    expect((await as('dana', '/api/books/kites/archive')).statusCode).toBe(403);
    expect((await as('astra', '/api/books/epub/archive')).statusCode).toBe(404);
    expect((await as('astra', '/api/books/nope/archive')).statusCode).toBe(404);
  });
});

describe('archiveName', () => {
  it('keeps a name any file system will write', () => {
    expect(archiveName('Q/R: Tide? "Yes" <3')).toBe('Q R Tide Yes 3');
    expect(archiveName('שבעה עפיפונים מעל ורן...')).toBe('שבעה עפיפונים מעל ורן');
    expect(archiveName('   ')).toBe('Audiobook');
    expect([...archiveName('א'.repeat(300))]).toHaveLength(120);
  });
});
