import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeCompiler } from '@myriaddreamin/typst-ts-node-compiler';
import { type NotesExportDocument } from '@readport/shared';
import { svgPages } from './svgPages.js';

/**
 * Setting a book's highlights and notes in type: the document the app wrote,
 * through server/typst/notes.typ, to a PDF and pictures of its first pages.
 *
 * Typst does the typesetting - real line breaking and hyphenation, a page
 * that is dark to its edges when the look is Night, right-to-left and CJK
 * set properly, and the same pages on every device - with the fonts in
 * server/fonts/pdf and the pictures in server/typst/art, none of which the
 * runtime image has otherwise. One compiler is kept per thread and reused:
 * the fonts are read once, and each document after the first is quicker.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The template and its pictures. From src/notes and dist/notes alike, two levels up. */
export const TYPST_DIR = path.resolve(HERE, '../../typst');
export const PDF_FONTS_DIR = path.resolve(HERE, '../../fonts/pdf');
const TEMPLATE = path.join(TYPST_DIR, 'notes.typ');

export type CoverFormat = 'png' | 'jpg' | 'gif' | 'webp' | 'svg';

export interface TypesetJob {
  document: NotesExportDocument;
  /** The book's cover, when one is wanted and there is one to read. */
  cover: { bytes: Uint8Array; format: CoverFormat } | null;
  /** How many of the first pages to draw as pictures; 0 for none. */
  previewPages: number;
}

export interface TypesetResult {
  /** On an ArrayBuffer of its own, so the worker can hand it over without a copy. */
  pdf: Uint8Array<ArrayBuffer>;
  pages: string[];
  pageCount: number;
}

/** The template would not compile: what Typst said, for the log. */
export class TypesetError extends Error {}

let compiler: NodeCompiler | null = null;
let covers = 0;

function compilerHere(): NodeCompiler {
  compiler ??= NodeCompiler.create({
    workspace: TYPST_DIR,
    fontArgs: [{ fontPaths: [PDF_FONTS_DIR] }],
  });
  return compiler;
}

function attempt(job: TypesetJob, cover: TypesetJob['cover']): TypesetResult {
  const c = compilerHere();
  // Each cover under a name of its own, so a compile never sees the last one's.
  const coverPath = cover ? `/cover-${++covers}` : null;
  const coverFile = coverPath ? path.join(TYPST_DIR, coverPath) : null;
  if (cover && coverFile) c.mapShadow(coverFile, Buffer.from(cover.bytes));
  try {
    const data = {
      ...job.document,
      cover: cover !== null,
      coverPath,
      coverFormat: cover?.format ?? null,
    };
    const res = c.compile({ mainFilePath: TEMPLATE, inputs: { data: JSON.stringify(data) } });
    const doc = res.result;
    if (!doc) {
      const diagnostics = res.takeDiagnostics();
      const said = diagnostics ? (c.fetchDiagnostics(diagnostics) as { message?: string }[]) : [];
      throw new TypesetError(said.map((d) => d.message ?? '').join('; ') || 'typst failed');
    }
    const pdf = c.pdf(doc, { creationTimestamp: Math.floor(Date.now() / 1000) });
    const pages = job.previewPages > 0 ? svgPages(c.plainSvg(doc), job.previewPages) : [];
    return { pdf: new Uint8Array(pdf), pages, pageCount: doc.numOfPages };
  } finally {
    if (coverFile) c.unmapShadow(coverFile);
    // Keep what the next document will want - the fonts, the template -
    // and let go of what only this one did.
    c.evictCache(10);
  }
}

/**
 * The document as a PDF and pictures of its first pages. A cover Typst
 * cannot read (a damaged file, a format it does not know) costs the cover,
 * not the export: the title page then has the quill.
 */
export function typeset(job: TypesetJob): TypesetResult {
  try {
    return attempt(job, job.cover);
  } catch (e) {
    if (!job.cover || !(e instanceof TypesetError)) throw e;
    return attempt(job, null);
  }
}

/** A cover's format, from its first bytes; null for anything else. */
export function coverFormat(bytes: Uint8Array): CoverFormat | null {
  const b = bytes;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif';
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  const start = new TextDecoder().decode(b.subarray(0, 4096)).trimStart();
  if (start.startsWith('<') && /<svg[\s>]/.test(start)) return 'svg';
  return null;
}
