import { type NotesExportDocument } from '@readport/shared';
import { NotesTypesetter } from './pdf.js';

/**
 * `node server/dist/notes/selftest.js` - typesets a small invented export
 * on the worker thread, the way the route does, and says how it went.
 *
 * The typesetter is a native module with a binary per platform, and the
 * PDF needs fonts and a template the image carries beside the code; a
 * missing piece would show only when somebody exported. CI runs this in
 * the built image, and so can anyone checking an installation.
 */

const SAMPLE: NotesExportDocument = {
  look: 'night',
  page: 'a4',
  text: 'comfortable',
  lang: 'en',
  dir: 'ltr',
  bookLang: 'en',
  title: 'The Salt Clock',
  titleDir: 'ltr',
  author: 'Ines Varga',
  cover: false,
  reader: null,
  contents: false,
  labels: {
    app: 'ReadPort',
    heading: 'Highlights & notes',
    contents: 'Contents',
    note: 'Note',
    bookmark: 'Bookmark',
    marked: 'A marked passage',
    empty: 'Nothing to export.',
    reader: null,
    stamp: 'Exported from ReadPort',
    closing: 'Kept from your reading of The Salt Clock',
  },
  figures: [{ n: '3', label: 'highlights' }],
  scope: [],
  legend: [{ color: 'amber', label: 'Amber' }],
  sections: [
    {
      kind: 'chapter',
      head: 'Low Water',
      dir: 'ltr',
      color: null,
      count: '3 highlights',
      marks: [
        ['The tide came in twice that day, and nobody on the quay could say why.', 'ltr'],
        ['הגאות עלתה פעמיים באותו יום.', 'rtl'],
        ['潮は一日に二度満ちた。 조수는 하루에 두 번 들어왔다. 潮水涨了两次。', 'ltr'],
      ].map(([text, dir]) => ({
        kind: 'highlight' as const,
        color: 'amber' as const,
        text: text!,
        note: null,
        where: '12%',
        dir: dir as 'ltr' | 'rtl',
        noteDir: 'ltr' as const,
      })),
    },
  ],
};

const typesetter = new NotesTypesetter();
const started = Date.now();
try {
  const result = await typesetter.typeset({ document: SAMPLE, cover: null, previewPages: 1 });
  const pdf = Buffer.from(result.pdf).subarray(0, 5).toString('latin1');
  if (pdf !== '%PDF-' || result.pageCount < 2 || !result.pages[0]?.startsWith('<svg')) {
    throw new Error(`unexpected output: ${pdf}, ${result.pageCount} pages`);
  }
  console.log(
    `notes export ok: ${result.pageCount} pages, ${result.pdf.byteLength} bytes, ${Date.now() - started} ms`,
  );
} catch (e) {
  console.error('notes export FAILED:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  typesetter.close();
}
