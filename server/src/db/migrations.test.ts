import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { placesDocSchema, readingPlaces } from '@readport/shared';
import { MIGRATIONS } from './migrations.js';
import { openDatabase } from './index.js';

/**
 * Migrations run on servers that have been reading books for months, not on
 * empty files. This builds a database at the previous version, puts real rows
 * in it, and then opens it the way the server does.
 */

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-migrate-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A database as it stood before `upTo` + 1 was written. */
function databaseAtVersion(upTo: number): void {
  const db = new DatabaseSync(path.join(dir, 'readport.db'));
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);',
  );
  for (const m of MIGRATIONS) {
    if (m.version > upTo) break;
    db.exec(m.sql);
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
      m.version,
      new Date().toISOString(),
    );
  }
  db.prepare(
    "INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('u1', 'ada', 'x', 'reader', ?)",
  ).run(new Date().toISOString());
  db.prepare(
    `INSERT INTO books (id, kind, root_dir, rel_path, format, title, added_at)
     VALUES ('b1', 'ebook', '/lib', 'a.epub', 'epub', 'The Lamp at Varenne', ?)`,
  ).run(new Date().toISOString());
  db.close();
}

describe('schema migrations', () => {
  it('upgrades v14 reset barriers without changing generations and cascades account deletion', () => {
    databaseAtVersion(14);
    const old = new DatabaseSync(path.join(dir, 'readport.db'));
    old.exec("INSERT INTO progress_resets VALUES ('u1', 'b1', 7), ('deleted-user', 'b1', 3)");
    old.close();
    const db = openDatabase(dir);
    try {
      expect(db.prepare('SELECT * FROM progress_resets').all()).toEqual([
        { user_id: 'u1', book_id: 'b1', generation: 7 },
      ]);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      db.prepare("DELETE FROM users WHERE id = 'u1'").run();
      expect(db.prepare('SELECT * FROM progress_resets').all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('are numbered once and in order', () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
  });

  it('shelves apply to a database that already holds books and people', () => {
    const previous = MIGRATIONS[MIGRATIONS.length - 1]!.version - 1;
    databaseAtVersion(previous);

    const db = openDatabase(dir);
    // Nothing the server was already storing was disturbed.
    expect(db.prepare('SELECT title FROM books WHERE id = ?').get('b1')).toMatchObject({
      title: 'The Lamp at Varenne',
    });
    const applied = (
      db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as {
        version: number;
      }[]
    ).map((r) => r.version);
    expect(applied).toEqual(MIGRATIONS.map((m) => m.version));

    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO shelves (id, user_id, name, sort_key, created_at, updated_at) VALUES ('s1','u1','Summer','U',?,?)",
    ).run(now, now);
    db.prepare(
      "INSERT INTO shelf_items (shelf_id, book_id, sort_key, added_at) VALUES ('s1','b1','U',?)",
    ).run(now);
    db.prepare(
      "INSERT INTO reading_list (user_id, book_id, sort_key, added_at) VALUES ('u1','b1','U',?)",
    ).run(now);

    // Names differing only in case are the same shelf name.
    expect(() =>
      db
        .prepare(
          "INSERT INTO shelves (id, user_id, name, sort_key, created_at, updated_at) VALUES ('s2','u1','summer','V',?,?)",
        )
        .run(now, now),
    ).toThrow();
    // The same book cannot be queued twice.
    expect(() =>
      db
        .prepare(
          "INSERT INTO reading_list (user_id, book_id, sort_key, added_at) VALUES ('u1','b1','V',?)",
        )
        .run(now),
    ).toThrow();

    // Deleting the account takes the furniture with it, through the foreign
    // key rather than through a hand-written list of table names.
    db.prepare('DELETE FROM users WHERE id = ?').run('u1');
    for (const table of ['shelves', 'shelf_items', 'reading_list']) {
      expect(db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get()).toMatchObject({ c: 0 });
    }
    // The book itself is library content and stays.
    expect(db.prepare('SELECT COUNT(*) AS c FROM books').get()).toMatchObject({ c: 1 });
    db.close();
  });

  it('gives everyone already reading a book their place in it', () => {
    databaseAtVersion(26);
    const old = new DatabaseSync(path.join(dir, 'readport.db'));
    const now = new Date().toISOString();
    old
      .prepare(
        `INSERT INTO books (id, kind, root_dir, rel_path, format, title, added_at)
         VALUES ('b2', 'ebook', '/lib', 'b.epub', 'epub', 'Rooms Above the Ferry', ?)`,
      )
      .run(now);
    const progress = old.prepare(
      `INSERT INTO progress_state (user_id, book_id, revision, locator_json, intent, occurred_at,
         session_uuid, device_id, seq, finished, updated_at)
       VALUES ('u1', ?, 3, ?, 'heartbeat', ?, 's', 'd', 3, 0, ?)`,
    );
    progress.run('b1', '{"medium":"ebook","spineIdx":4,"charOffset":120,"pct":0.2}', now, now);
    progress.run('b2', '{"medium":"ebook","spineIdx":9,"charOffset":40,"pct":0.5}', now, now);
    const sitting = old.prepare(
      `INSERT INTO reading_sessions (user_id, book_id, medium, device_id, started_at, ended_at,
         pct_start, pct_end, active_ms)
       VALUES ('u1', ?, 'ebook', 'd', ?, ?, 0, 0.1, ?)`,
    );
    sitting.run('b1', now, now, 20 * 60_000);
    sitting.run('b1', now, now, 10 * 60_000);
    // Opened once at a passage and put down: no place.
    sitting.run('b2', now, now, 10_000);
    old.close();

    const db = openDatabase(dir);
    try {
      const rows = db.prepare('SELECT book_id, doc_json FROM reading_places').all() as {
        book_id: string;
        doc_json: string;
      }[];
      expect(rows.map((r) => r.book_id)).toEqual(['b1']);
      const doc = placesDocSchema.parse(JSON.parse(rows[0]!.doc_json));
      const [place] = readingPlaces(doc);
      expect(place).toMatchObject({ main: true, current: true });
      expect(place!.thread).toMatchObject({ to: 0.2, readMs: 30 * 60_000 });
      expect(place!.thread.locator).toMatchObject({ spineIdx: 4, charOffset: 120 });
      db.prepare("DELETE FROM users WHERE id = 'u1'").run();
      expect(db.prepare('SELECT COUNT(*) AS c FROM reading_places').get()).toMatchObject({ c: 0 });
    } finally {
      db.close();
    }
  });

  it('re-opening an already-migrated database changes nothing', () => {
    const first = openDatabase(dir);
    const before = first.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get();
    first.close();
    const second = openDatabase(dir);
    expect(second.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get()).toEqual(before);
    second.close();
  });
});
