import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

/**
 * The link preview: a 1200x630 PNG composed as SVG and rasterised on the
 * server by resvg, which ships its own renderer and takes the fonts it is
 * handed - the runtime image has no fonts of its own and no image library.
 *
 * Composition, in the app's "ink & ember" palette: warm dark ground, the
 * cover on the left with a soft shadow, and on the right the mark and
 * wordmark, the title in Literata, the author, and a caption saying what
 * this is. A title in a script the bundled fonts cannot shape (Hebrew,
 * Arabic, CJK) is left out rather than drawn as boxes: the cover carries it,
 * and so does og:title.
 */

export const SHARE_IMAGE_WIDTH = 1200;
export const SHARE_IMAGE_HEIGHT = 630;

/* The ink & ember dark theme (web/src/styles/tokens.css). */
const INK = '#16120f';
const CREAM = '#efe7d9';
const SOFT = '#a99f91';
const EMBER = '#c86a3e';
const EMBER_TEXT = '#e69c74';
const PLUM = '#5e4a8a';
/* The same tints the web's placeholder cover deals from a book's id. */
const COVER_TINTS = ['#8C3F1F', '#5E4A8A', '#2F4A5C', '#6B3A44', '#4E5A2E', '#8A6A2F'];

const FONTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fonts');
/** The family names inside the files, which is how the SVG has to ask for them. */
const SERIF = 'Literata 36pt';
const SANS = 'Inter';
const FONT_FILES = ['Literata36pt-SemiBold.ttf', 'Inter[opsz,wght].ttf'];

/** The ReadPort mark (web/src/components/icons.tsx), in a 24-unit box. */
const MARK_PATH =
  'M5.6 4.1 a2.3 2.3 0 0 1 2.3 -2.3 h8.2 a2.3 2.3 0 0 1 2.3 2.3 V22.2 L12 17.9 L5.6 22.2 Z M9.7 6.8 L15.7 10.775 L9.7 14.75 Z';

/**
 * Only the bundled faces, and the generic families mapped onto them - so a
 * cover that is itself an SVG asking for "serif" still shows its lettering.
 */
const resvgOptions = () => ({
  font: {
    fontFiles: FONT_FILES.map((f) => path.join(FONTS_DIR, f)),
    loadSystemFonts: false,
    defaultFontFamily: SANS,
    serifFamily: SERIF,
    sansSerifFamily: SANS,
    cursiveFamily: SERIF,
    fantasyFamily: SERIF,
    monospaceFamily: SANS,
  },
});

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Whether the bundled fonts can shape this text: Latin, Cyrillic and Greek
 * letters, plus the digits, punctuation and marks every script shares.
 * Emoji are "Common" too, and would render as nothing, so they count as
 * unshapeable as well.
 */
const SHAPEABLE =
  /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Common}\p{Script=Inherited}]*$/u;
export function canRenderText(text: string): boolean {
  return SHAPEABLE.test(text) && !/\p{Extended_Pictographic}/u.test(text);
}

/** The width of one line as the renderer will draw it - measured, not estimated. */
export function measureText(text: string, family: string, size: number): number {
  if (!text) return 0;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="${size * 3}"><text x="0" y="${size * 2}" font-family="${escapeXml(family)}" font-size="${size}">${escapeXml(text)}</text></svg>`;
  const box = new Resvg(svg, resvgOptions()).getBBox();
  return box ? box.width : 0;
}

/**
 * Greedy word wrap against measured widths. A single word wider than the
 * line is broken by characters. Returns null when the text needs more lines
 * than allowed, so the caller can try a smaller size.
 */
export function wrapText(
  text: string,
  family: string,
  size: number,
  maxWidth: number,
  maxLines: number,
): string[] | null {
  const fits = (s: string) => measureText(s, family, size) <= maxWidth;
  const lines: string[] = [];
  let current = '';
  const push = (line: string) => {
    lines.push(line);
    return lines.length <= maxLines;
  };
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = current ? `${current} ${word}` : word;
    if (fits(candidate)) {
      current = candidate;
      continue;
    }
    if (current && !push(current)) return null;
    current = '';
    if (fits(word)) {
      current = word;
      continue;
    }
    // Longer than a whole line: break it wherever it stops fitting.
    for (const ch of word) {
      if (fits(current + ch)) current += ch;
      else {
        if (current && !push(current)) return null;
        current = ch;
      }
    }
  }
  if (current && !push(current)) return null;
  return lines;
}

/** The vertical distance between two baselines at a size. */
const lineStep = (size: number, lineHeight: number) => Math.round(size * lineHeight);

/** How tall a block of `n` lines is, from the top of the first to the baseline of the last. */
const blockHeight = (size: number, n: number, lineHeight: number) =>
  size + (n - 1) * lineStep(size, lineHeight);

/**
 * Wrap at the largest of `sizes` whose lines fit the width, the line cap
 * AND the height on offer; at the smallest, cut with an ellipsis. A block
 * that runs into the caption below it is the one thing this must not do.
 */
function fitText(
  text: string,
  family: string,
  sizes: number[],
  maxWidth: number,
  maxLines: number,
  opts: { maxHeight?: number; lineHeight?: number } = {},
): { size: number; lines: string[] } {
  const lineHeight = opts.lineHeight ?? 1.18;
  const allowed = (size: number) =>
    opts.maxHeight === undefined
      ? maxLines
      : Math.min(maxLines, Math.floor((opts.maxHeight - size) / lineStep(size, lineHeight)) + 1);
  for (const size of sizes) {
    if (allowed(size) < 1) continue;
    const lines = wrapText(text, family, size, maxWidth, allowed(size));
    if (lines) return { size, lines };
  }
  const size = sizes[sizes.length - 1]!;
  const cap = Math.max(1, allowed(size));
  const words = text.split(/\s+/).filter(Boolean);
  // Drop words from the end until the whole thing, ellipsis included, fits.
  for (let n = words.length - 1; n > 0; n--) {
    const lines = wrapText(`${words.slice(0, n).join(' ')}…`, family, size, maxWidth, cap);
    if (lines) return { size, lines };
  }
  return { size, lines: [`${[...text].slice(0, 12).join('')}…`] };
}

/* ---------------------------------------------------------------- images */

export interface CoverImage {
  mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/svg+xml';
  data: Buffer;
  width: number;
  height: number;
}

/** Covers past this are not worth base64-ing into an SVG; the placeholder stands in. */
const COVER_BYTES_MAX = 8 * 1024 * 1024;

/**
 * Sniff the format and read the pixel size from the header, so a square
 * audiobook cover and a tall ebook cover are each drawn at their own shape
 * instead of one being cropped to the other's. Anything else - WebP, a file
 * that is not an image - yields null and the placeholder.
 */
export function readCover(file: string | null): CoverImage | null {
  if (!file) return null;
  let data: Buffer;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > COVER_BYTES_MAX) return null;
    data = fs.readFileSync(file);
  } catch {
    return null;
  }
  const size = imageSize(data);
  if (!size) return null;
  return { ...size, data };
}

export function imageSize(
  data: Buffer,
): { mime: CoverImage['mime']; width: number; height: number } | null {
  if (data.length >= 24 && data.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { mime: 'image/png', width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return jpegSize(data);
  }
  if (data.length >= 10 && data.subarray(0, 6).toString('latin1').startsWith('GIF8')) {
    return { mime: 'image/gif', width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  }
  const head = data.subarray(0, 4096).toString('utf8');
  if (/<svg[\s>]/i.test(head)) return svgSize(head);
  return null;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Walk the JPEG segments to the first start-of-frame marker. */
function jpegSize(data: Buffer): { mime: 'image/jpeg'; width: number; height: number } | null {
  let at = 2;
  while (at + 9 < data.length) {
    if (data[at] !== 0xff) return null;
    const marker = data[at + 1]!;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      at += 2;
      continue;
    }
    const length = data.readUInt16BE(at + 2);
    const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrame) {
      return {
        mime: 'image/jpeg',
        height: data.readUInt16BE(at + 5),
        width: data.readUInt16BE(at + 7),
      };
    }
    at += 2 + length;
  }
  return null;
}

function svgSize(head: string): { mime: 'image/svg+xml'; width: number; height: number } | null {
  const tag = /<svg[^>]*>/i.exec(head)?.[0] ?? '';
  const attr = (name: string) => {
    const m = new RegExp(`\\s${name}="([^"]+)"`, 'i').exec(tag);
    return m ? parseFloat(m[1]!) : NaN;
  };
  let width = attr('width');
  let height = attr('height');
  if (!(width > 0 && height > 0)) {
    const viewBox = /\sviewBox="([^"]+)"/i
      .exec(tag)?.[1]
      ?.trim()
      .split(/[\s,]+/)
      .map(Number);
    if (viewBox?.length === 4 && viewBox[2]! > 0 && viewBox[3]! > 0) {
      width = viewBox[2]!;
      height = viewBox[3]!;
    }
  }
  if (!(width > 0 && height > 0)) return null;
  return { mime: 'image/svg+xml', width, height };
}

/* ------------------------------------------------------------ composition */

/** The tint the web deals a coverless book from its id, so both sides agree. */
export function coverTint(bookId: string): string {
  let hash = 0;
  for (const c of bookId) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return COVER_TINTS[hash % COVER_TINTS.length]!;
}

export interface ShareImageInput {
  bookId: string;
  title: string;
  author: string | null;
  cover: CoverImage | null;
  /** The caption under the title; English, because crawlers read it. */
  caption?: string;
}

const PAD = 88;
const COVER_TOP = 125;
const COVER_BOX_W = 300;
const COVER_BOX_H = 380;
const COLUMN_X = PAD + COVER_BOX_W + 64;
const COLUMN_W = SHARE_IMAGE_WIDTH - COLUMN_X - PAD;

function frame(): string {
  return `
  <rect width="${SHARE_IMAGE_WIDTH}" height="${SHARE_IMAGE_HEIGHT}" fill="${INK}"/>
  <rect width="${SHARE_IMAGE_WIDTH}" height="${SHARE_IMAGE_HEIGHT}" fill="url(#glow)"/>
  <rect width="${SHARE_IMAGE_WIDTH}" height="${SHARE_IMAGE_HEIGHT}" fill="url(#plum)"/>`;
}

function defs(): string {
  return `
  <defs>
    <radialGradient id="glow" cx="0.18" cy="0.05" r="0.9">
      <stop offset="0" stop-color="${EMBER}" stop-opacity="0.34"/>
      <stop offset="0.55" stop-color="${EMBER}" stop-opacity="0.06"/>
      <stop offset="1" stop-color="${EMBER}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="plum" cx="0.95" cy="1.05" r="0.7">
      <stop offset="0" stop-color="${PLUM}" stop-opacity="0.45"/>
      <stop offset="1" stop-color="${PLUM}" stop-opacity="0"/>
    </radialGradient>
    <filter id="shadow" x="-30%" y="-20%" width="160%" height="150%">
      <feGaussianBlur stdDeviation="16"/>
    </filter>
  </defs>`;
}

function mark(x: number, y: number, size: number, fill: string): string {
  const s = size / 24;
  return `<path d="${MARK_PATH}" fill="${fill}" fill-rule="evenodd" transform="translate(${x} ${y}) scale(${s})"/>`;
}

function textBlock(
  lines: string[],
  x: number,
  top: number,
  family: string,
  size: number,
  fill: string,
  lineHeight = 1.18,
): { svg: string; bottom: number } {
  const step = Math.round(size * lineHeight);
  const spans = lines
    .map((line, i) => `<tspan x="${x}" y="${top + size + i * step}">${escapeXml(line)}</tspan>`)
    .join('');
  return {
    svg: `<text font-family="${escapeXml(family)}" font-size="${size}" fill="${fill}">${spans}</text>`,
    bottom: top + size + (lines.length - 1) * step,
  };
}

/** The cover, scaled to fit its box, with its shadow - or a tinted stand-in. */
function coverArt(input: ShareImageInput, titleShapeable: boolean): string {
  const { cover } = input;
  let w: number;
  let h: number;
  if (cover) {
    const scale = Math.min(COVER_BOX_W / cover.width, COVER_BOX_H / cover.height);
    w = Math.round(cover.width * scale);
    h = Math.round(cover.height * scale);
  } else {
    w = 253;
    h = COVER_BOX_H;
  }
  const x = PAD + Math.round((COVER_BOX_W - w) / 2);
  const y = COVER_TOP + Math.round((COVER_BOX_H - h) / 2);
  const shadow = `<rect x="${x}" y="${y + 18}" width="${w}" height="${h}" rx="12" fill="#000" opacity="0.55" filter="url(#shadow)"/>`;
  if (cover) {
    const href = `data:${cover.mime};base64,${cover.data.toString('base64')}`;
    return `${shadow}
  <clipPath id="cover-clip"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10"/></clipPath>
  <image href="${href}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="none" clip-path="url(#cover-clip)"/>
  <rect x="${x + 0.5}" y="${y + 0.5}" width="${w - 1}" height="${h - 1}" rx="10" fill="none" stroke="#fff" stroke-opacity="0.12"/>`;
  }
  // No cover: the same tinted placeholder the web shows, title and all.
  const tint = coverTint(input.bookId);
  let inner = '';
  if (titleShapeable) {
    const title = fitText(input.title, SERIF, [26, 22, 19], w - 40, 6);
    const block = textBlock(title.lines, x + 20, y + 28, SERIF, title.size, '#F8F2E8', 1.2);
    inner = block.svg;
    if (input.author && canRenderText(input.author)) {
      const author = fitText(input.author, SANS, [16, 14], w - 40, 2);
      inner += textBlock(
        author.lines,
        x + 20,
        block.bottom + 14,
        SANS,
        author.size,
        '#F8F2E8',
        1.25,
      ).svg;
    }
  } else {
    inner = mark(x + w / 2 - 44, y + h / 2 - 50, 88, '#F8F2E8');
  }
  return `${shadow}
  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${tint}"/>
  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="url(#glow)" opacity="0.5"/>
  ${inner}`;
}

/** The SVG for one book's preview. Exported for tests and for the app image. */
export function shareImageSvg(input: ShareImageInput): string {
  const caption = input.caption ?? 'Shared with you on ReadPort';
  const titleShapeable = canRenderText(input.title);
  const authorShapeable = Boolean(input.author) && canRenderText(input.author!);
  const parts: string[] = [];

  // Brand row, aligned with the top of the cover.
  parts.push(mark(COLUMN_X - 2, COVER_TOP - 3, 34, EMBER_TEXT));
  parts.push(
    `<text x="${COLUMN_X + 40}" y="${COVER_TOP + 24}" font-family="${SERIF}" font-size="26" fill="${CREAM}" letter-spacing="0.5">ReadPort</text>`,
  );

  // The caption sits on the cover's bottom line; everything above it has to
  // stop short of its rule. The author is fitted first so the title can be
  // sized to the room that is left.
  const captionY = COVER_TOP + COVER_BOX_H - 4;
  const columnBottom = captionY - 38 - 24;
  const TITLE_GAP = 26;
  const author =
    input.author && authorShapeable
      ? fitText(input.author, SANS, [30, 26, 22], COLUMN_W, 2, { lineHeight: 1.25 })
      : null;
  const authorHeight = author ? blockHeight(author.size, author.lines.length, 1.25) : 0;

  let cursor = COVER_TOP + 76;
  if (titleShapeable) {
    const title = fitText(input.title, SERIF, [58, 50, 44, 38, 33], COLUMN_W, 4, {
      lineHeight: 1.14,
      maxHeight: columnBottom - cursor - (author ? TITLE_GAP + authorHeight : 0),
    });
    const block = textBlock(title.lines, COLUMN_X, cursor, SERIF, title.size, CREAM, 1.14);
    parts.push(block.svg);
    cursor = block.bottom + TITLE_GAP;
  } else {
    // A script the fonts cannot draw: a quiet rule holds the title's place,
    // and the cover on the left carries the title itself.
    parts.push(
      `<rect x="${COLUMN_X}" y="${cursor + 10}" width="120" height="4" rx="2" fill="${EMBER}" opacity="0.8"/>`,
    );
    cursor += 44;
  }
  if (author) {
    parts.push(textBlock(author.lines, COLUMN_X, cursor, SANS, author.size, SOFT, 1.25).svg);
  }
  parts.push(
    `<rect x="${COLUMN_X}" y="${captionY - 38}" width="28" height="3" rx="1.5" fill="${EMBER}"/>`,
  );
  parts.push(
    `<text x="${COLUMN_X}" y="${captionY}" font-family="${SANS}" font-size="22" fill="${EMBER_TEXT}" letter-spacing="0.2">${escapeXml(caption)}</text>`,
  );

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SHARE_IMAGE_WIDTH}" height="${SHARE_IMAGE_HEIGHT}" viewBox="0 0 ${SHARE_IMAGE_WIDTH} ${SHARE_IMAGE_HEIGHT}">${defs()}${frame()}
  ${coverArt(input, titleShapeable)}
  ${parts.join('\n  ')}
</svg>`;
}

/** The app's own preview, for a plain link to the server: mark, wordmark, tagline. */
export function appImageSvg(): string {
  const cx = 150;
  const cy = 215;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SHARE_IMAGE_WIDTH}" height="${SHARE_IMAGE_HEIGHT}" viewBox="0 0 ${SHARE_IMAGE_WIDTH} ${SHARE_IMAGE_HEIGHT}">${defs()}${frame()}
  <rect x="${cx + 8}" y="${cy + 26}" width="184" height="200" rx="24" fill="#000" opacity="0.5" filter="url(#shadow)"/>
  ${mark(cx, cy, 200, EMBER_TEXT)}
  <text x="400" y="${cy + 132}" font-family="${SERIF}" font-size="124" fill="${CREAM}" letter-spacing="-1">ReadPort</text>
  <rect x="404" y="${cy + 172}" width="36" height="4" rx="2" fill="${EMBER}"/>
  <text x="404" y="${cy + 222}" font-family="${SANS}" font-size="34" fill="${SOFT}" letter-spacing="0.2">Read and listen in perfect tandem.</text>
  <text x="404" y="${cy + 268}" font-family="${SANS}" font-size="24" fill="${SOFT}" opacity="0.8" letter-spacing="0.2">Your own library: ebooks and audiobooks, lined up to the sentence.</text>
</svg>`;
}

export function renderSvgToPng(svg: string): Buffer {
  const resvg = new Resvg(svg, {
    ...resvgOptions(),
    fitTo: { mode: 'width', value: SHARE_IMAGE_WIDTH },
  });
  return Buffer.from(resvg.render().asPng());
}

export function renderShareImage(input: ShareImageInput): Buffer {
  return renderSvgToPng(shareImageSvg(input));
}

export function renderAppImage(): Buffer {
  return renderSvgToPng(appImageSvg());
}

/* ------------------------------------------------------------------ cache */

export const SHARE_IMAGE_TTL_MS = 60 * 60_000;
/** Bound on memory: a hundred previews at a couple of hundred kilobytes each. */
const CACHE_MAX = 100;

const cache = new Map<string, { png: Buffer; at: number }>();

/** The rendered preview for a token, kept for an hour. */
export function cachedShareImage(token: string, render: () => Buffer): Buffer {
  const hit = cache.get(token);
  const now = Date.now();
  if (hit && now - hit.at < SHARE_IMAGE_TTL_MS) return hit.png;
  const png = render();
  cache.delete(token);
  cache.set(token, { png, at: now });
  for (const [key, entry] of cache) {
    if (cache.size <= CACHE_MAX && now - entry.at < SHARE_IMAGE_TTL_MS) break;
    cache.delete(key);
  }
  return png;
}

/** A revoked share must not keep serving its picture from memory. */
export function forgetShareImage(token: string): void {
  cache.delete(token);
}
