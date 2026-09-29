import { parentPort } from 'node:worker_threads';
import { typeset, type TypesetJob } from './typeset.js';

/**
 * The typesetter's own thread (see NotesTypesetter in pdf.ts). A long
 * export takes a second or two of solid work, and on the server's main
 * thread that is a second or two in which nobody's page turns, audio
 * seeks or sign-ins are answered. Jobs arrive one at a time and go back
 * the same way; the PDF's bytes are handed over, not copied.
 */
parentPort?.on('message', (message: { id: number; job: TypesetJob }) => {
  try {
    const result = typeset(message.job);
    parentPort!.postMessage({ id: message.id, ok: true, result }, [result.pdf.buffer]);
  } catch (e) {
    parentPort!.postMessage({
      id: message.id,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
});
