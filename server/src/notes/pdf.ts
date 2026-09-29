import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { typeset, type TypesetJob, type TypesetResult } from './typeset.js';

/**
 * Where exports are typeset: one worker thread, started on the first export
 * and stopped again after a few idle minutes, so a server nobody exports
 * from carries no compiler and no fonts in memory.
 *
 * Jobs queue in the worker and are done in turn. A queue already
 * `maxQueue` deep turns the next one away (the route answers 503 and the
 * app says to try again) rather than letting one person's impatience make
 * everyone wait; a job that runs past `timeoutMs` stops the worker - a
 * compile cannot be interrupted any other way - and the next export starts
 * a fresh one.
 *
 * Under test the worker's compiled file does not exist (vitest runs the
 * TypeScript), and the same work is done inline.
 */

const WORKER = new URL('./typeset-worker.js', import.meta.url);

export class TypesetterBusy extends Error {}

interface Waiting {
  resolve: (r: TypesetResult) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class NotesTypesetter {
  private worker: Worker | null = null;
  private waiting = new Map<number, Waiting>();
  private nextId = 1;
  private idle: NodeJS.Timeout | null = null;
  private readonly inline: boolean;
  private readonly timeoutMs: number;
  private readonly maxQueue: number;
  private readonly idleMs: number;

  constructor(
    opts: { inline?: boolean; timeoutMs?: number; maxQueue?: number; idleMs?: number } = {},
  ) {
    this.inline = opts.inline ?? !fs.existsSync(fileURLToPath(WORKER));
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.maxQueue = opts.maxQueue ?? 4;
    this.idleMs = opts.idleMs ?? 5 * 60_000;
  }

  async typeset(job: TypesetJob): Promise<TypesetResult> {
    if (this.inline) return typeset(job);
    if (this.waiting.size >= this.maxQueue) throw new TypesetterBusy('typesetter busy');
    const worker = this.start();
    const id = this.nextId++;
    return new Promise<TypesetResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.stop(new Error('typesetting took too long'));
      }, this.timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
      worker.postMessage({ id, job });
    });
  }

  /** Stop the worker now, failing whatever it still had to do. */
  close(): void {
    this.stop(new Error('typesetter closed'));
  }

  private start(): Worker {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    if (this.worker) return this.worker;
    const worker = new Worker(WORKER);
    worker.on(
      'message',
      (
        msg:
          | { id: number; ok: true; result: TypesetResult }
          | { id: number; ok: false; error: string },
      ) => {
        const w = this.waiting.get(msg.id);
        if (!w) return;
        this.waiting.delete(msg.id);
        clearTimeout(w.timer);
        if (msg.ok) w.resolve(msg.result);
        else w.reject(new Error(msg.error));
        if (this.waiting.size === 0) this.rest();
      },
    );
    worker.on('error', (e) => this.stop(e));
    worker.on('exit', () => {
      if (this.worker === worker) this.stop(new Error('typesetter stopped'));
    });
    // Its own thread, but not a reason to keep the process alive.
    worker.unref();
    this.worker = worker;
    return worker;
  }

  private rest(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.stop(new Error('idle')), this.idleMs);
    this.idle.unref();
  }

  private stop(reason: Error): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    const worker = this.worker;
    this.worker = null;
    for (const w of this.waiting.values()) {
      clearTimeout(w.timer);
      w.reject(reason);
    }
    this.waiting.clear();
    void worker?.terminate();
  }
}
