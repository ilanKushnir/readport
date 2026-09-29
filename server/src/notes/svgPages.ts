/**
 * The first pages of a typeset document, each as a picture of its own.
 *
 * Typst's plain SVG is the whole document as one tall drawing: for each page
 * a background rectangle and one group (moved down by the height of the
 * pages above it), and at the end the glyphs every page draws its letters
 * with and the clipping shapes, shared by all. A preview wants a page at a
 * time, and only the first few - so this cuts the drawing apart: one SVG per
 * page, its group moved back to the top, carrying only the glyphs and clips
 * that page uses. The letters are outlines, not text, so the pictures say
 * nothing a font on the viewer's device could change.
 *
 * It reads the layout typst-ts 0.7 writes (the version is pinned in
 * server/package.json), and says so by returning nothing it cannot read
 * rather than a page that is wrong.
 */

interface Chunk {
  background: string;
  body: string[];
}

const PAGE_BG = /^ {4}<path class="typst-shape"[^>]*\/>$/;
const PAGE_OPEN = /^ {4}<g(?: transform="[^"]*")?>$/;
const PAGE_CLOSE = /^ {4}<\/g>$/;
const DEFS_OPEN = /^ {4}<defs id="(glyph|clip-path)">$/;
const DEFS_CLOSE = /^ {4}<\/defs>$/;
const DEF_OPEN = /^ {8}<(symbol|clipPath) id="([^"]+)"/;
const DEF_CLOSE = /^ {8}<\/(symbol|clipPath)>$/;

/** Up to `max` pages of `svg`, each a standalone SVG document. */
export function svgPages(svg: string, max: number): string[] {
  if (max <= 0) return [];
  const lines = svg.split('\n');
  const head = lines[0] ?? '';
  const box = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(head);
  if (!head.startsWith('<svg') || !box) return [];
  const width = Number(box[1]);

  const pages: Chunk[] = [];
  const defs = new Map<string, string[]>();
  let page: Chunk | null = null;
  let background: string | null = null;
  let def: { id: string; lines: string[] } | null = null;
  let inDefs = false;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (page) {
      if (PAGE_CLOSE.test(line)) {
        pages.push(page);
        page = null;
      } else page.body.push(line);
      continue;
    }
    if (inDefs) {
      if (DEFS_CLOSE.test(line)) {
        inDefs = false;
        continue;
      }
      if (def) {
        def.lines.push(line);
        if (DEF_CLOSE.test(line)) {
          defs.set(def.id, def.lines);
          def = null;
        }
        continue;
      }
      const open = DEF_OPEN.exec(line);
      if (open) {
        def = { id: open[2]!, lines: [line] };
        if (DEF_CLOSE.test(line) || line.endsWith('/>')) {
          defs.set(def.id, def.lines);
          def = null;
        }
      }
      continue;
    }
    if (PAGE_BG.test(line)) background = line;
    else if (PAGE_OPEN.test(line) && background !== null) {
      page = { background, body: [] };
      background = null;
    } else if (DEFS_OPEN.test(line)) inDefs = true;
  }
  if (pages.length === 0) return [];

  return pages.slice(0, max).map((p) => {
    const height = Number(/v ([\d.]+) h /.exec(p.background)?.[1] ?? 0);
    const body = p.body.join('\n');
    // Each glyph and clip the page uses, under a short name of its own.
    const names = new Map<string, string>();
    for (const m of body.matchAll(/href="#([^"]+)"|url\(#([^)]+)\)/g)) {
      const id = m[1] ?? m[2]!;
      if (defs.has(id) && !names.has(id)) names.set(id, `${id[0]}${names.size.toString(36)}`);
    }
    const glyphs: string[] = [];
    const clips: string[] = [];
    for (const id of names.keys()) {
      const lines = defs.get(id)!;
      (lines[0]!.includes('<clipPath') ? clips : glyphs).push(...lines);
    }
    const svg = [
      `<svg class="typst-doc" viewBox="0 0 ${width} ${height}" width="${width}pt" height="${height}pt" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">`,
      p.background,
      '<g>',
      body,
      '</g>',
      '<defs>',
      ...glyphs,
      ...clips,
      '</defs>',
      '</svg>',
    ].join('\n');
    return compact(svg, names);
  });
}

/**
 * The same picture in fewer bytes: short names for the glyphs, coordinates
 * to a thousandth of a point (a preview is drawn at about a pixel a point),
 * no indentation, and no attribute that only says the default.
 */
function compact(svg: string, names: Map<string, string>): string {
  return svg
    .replace(/(["#])([gc][0-9A-F]{16,})(?=[")])/g, (whole, lead: string, id: string) => {
      const short = names.get(id);
      return short ? lead + short : whole;
    })
    .replace(/(\d\.\d{3})\d+/g, '$1')
    .replace(/ fill-rule="nonzero"/g, '')
    .replace(/\n\s+/g, '\n');
}
