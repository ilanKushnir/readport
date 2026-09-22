import fs from 'node:fs';
import path from 'node:path';
import { sampleWindows, windowOffsets } from '../alignment/detect-language.js';
import { loadManifest, loadSentencesText } from '../epub/extract.js';

/**
 * The windows of prose the language detector reads, taken from a book's
 * derived directory.
 *
 * Read from the raw chapter text (`text_N.txt`, with its capitals, its
 * accents and its final letters intact) rather than from the normalised
 * sentence text alignment uses, and read by the chapter, not by the book:
 * the manifest says how many characters each chapter holds, so the
 * detector's plan of offsets is answered by opening only the chapters a
 * window lands in. A twenty-megabyte book costs twelve small reads.
 *
 * A derived directory written by an older build has the sentence text and
 * nothing else; that is read whole and sampled the same way. Nothing
 * readable at all is an empty list, which the detector answers with
 * silence.
 */
export function proseWindows(derivedDir: string): string[] {
  const manifest = loadManifest(derivedDir);
  if (manifest && manifest.totalChars > 0 && manifest.chapters.length > 0) {
    const cache = new Map<number, string | null>();
    const chapterText = (idx: number): string | null => {
      if (!cache.has(idx)) {
        try {
          cache.set(idx, fs.readFileSync(path.join(derivedDir, `text_${idx}.txt`), 'utf8'));
        } catch {
          cache.set(idx, null);
        }
      }
      return cache.get(idx) ?? null;
    };
    const chapters = manifest.chapters;
    const windows: string[] = [];
    let complete = true;
    for (const { at, length } of windowOffsets(manifest.totalChars)) {
      let i = chapters.findIndex((c) => at >= c.cumChars && at < c.cumChars + c.charCount);
      if (i < 0) continue;
      let piece = '';
      let from = at - chapters[i]!.cumChars;
      // A window that runs past the end of its chapter continues into the next.
      while (piece.length < length && i < chapters.length) {
        const text = chapterText(chapters[i]!.idx);
        if (text === null) {
          complete = false;
          break;
        }
        piece += text.slice(from, from + (length - piece.length));
        from = 0;
        i++;
      }
      if (piece.trim()) windows.push(piece);
    }
    if (complete && windows.length > 0) return windows;
  }
  const sentences = loadSentencesText(derivedDir);
  return sentences ? sampleWindows(sentences.flat().join(' ')) : [];
}
