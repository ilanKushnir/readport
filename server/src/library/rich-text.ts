import { parseFragment } from 'parse5';
import { type RichBlock, type RichInline, type RichMark } from '@readport/shared';

/**
 * A book's description, from whatever the file wrote into a few shapes that
 * can be laid out.
 *
 * Descriptions arrive as HTML more often than not - Calibre and the metadata
 * sources it pulls from write `<p>`, `<b>`, `<br />`, entities and all, and a
 * page that prints that as text shows the reader a wall of tags. Some are
 * Markdown, some are plain text with blank lines between paragraphs. All of
 * them come out of here as paragraphs, headings, lists, quotes and rules,
 * with emphasis and links inside - and nothing else. No attribute survives
 * but a link's address, and only an http, https or mailto one, so whatever
 * a file put in its description, nothing of it can run on the page.
 */

/** Past this, a description is not a description; the rest is ignored rather than parsed. */
const MAX_INPUT = 40_000;
const MAX_BLOCKS = 200;

interface P5Node {
  nodeName: string;
  tagName?: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: P5Node[];
}

const MARKS: Record<string, RichMark> = {
  b: 'b',
  strong: 'b',
  i: 'i',
  em: 'i',
  cite: 'i',
  dfn: 'i',
  var: 'i',
  u: 'u',
  ins: 'u',
  s: 's',
  strike: 's',
  del: 's',
  code: 'code',
  tt: 'code',
  kbd: 'code',
  samp: 'code',
  sup: 'sup',
  sub: 'sub',
};

/** Starts a block of its own: whatever came before it ends its paragraph. */
const BLOCKS = new Set([
  'p',
  'div',
  'section',
  'article',
  'header',
  'footer',
  'aside',
  'main',
  'nav',
  'center',
  'blockquote',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'pre',
  'hr',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'figure',
  'figcaption',
  'address',
]);

/** Not text at all: nothing inside them is kept. */
const DROP = new Set([
  'script',
  'style',
  'template',
  'noscript',
  'iframe',
  'object',
  'embed',
  'head',
  'title',
  'svg',
  'math',
  'img',
  'picture',
  'video',
  'audio',
  'source',
  'canvas',
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'link',
  'meta',
]);

const HTML_TAG =
  /<\/?(p|br|b|i|u|s|em|strong|div|span|ul|ol|li|a|h[1-6]|blockquote|sup|sub|font|small|big|center|table|tr|td|hr|pre|code|cite|q|del|ins|strike|section|article)(\s[^<>]*)?\/?>/i;

/** Whether a description was written as HTML rather than as text or Markdown. */
export function looksLikeHtml(text: string): boolean {
  return HTML_TAG.test(text);
}

/** A link's address, when it is one a page may follow; null otherwise. */
export function safeHref(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const href = raw.trim();
  try {
    const url = new URL(href);
    if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:')
      return url.toString();
  } catch {
    /* relative, or not an address at all */
  }
  return null;
}

/* ------------------------------------------------------------ whitespace */

/**
 * Collapse the whitespace of a run of inline content the way a browser
 * would - one space for any run, none at the edges of a paragraph or around
 * a line break - and merge neighbouring text. Empty marks go.
 */
function tidy(nodes: RichInline[]): RichInline[] {
  const out: RichInline[] = [];
  const push = (n: RichInline) => {
    const last = out[out.length - 1];
    if (n.t === 'text' && last?.t === 'text') {
      last.v += n.v;
      return;
    }
    out.push(n);
  };
  for (const n of nodes) {
    if (n.t === 'text') {
      // HTML's whitespace, not \s: a no-break space is meant to stay.
      if (n.v) push({ t: 'text', v: n.v.replace(/[ \t\n\r\f]+/g, ' ') });
    } else if (n.t === 'br') {
      push(n);
    } else {
      const c = tidy(n.c);
      if (c.some((x) => x.t !== 'text' || x.v.trim())) push({ ...n, c } as RichInline);
      else if (c.length) push({ t: 'text', v: ' ' });
    }
  }
  // Two pieces of text merged can meet space to space.
  for (const n of out) if (n.t === 'text') n.v = n.v.replace(/ {2,}/g, ' ');
  // Spaces: none twice across a mark's edge, none at the ends, none next to a break.
  let prevEndsSpace = true;
  for (let k = 0; k < out.length; k++) {
    const n = out[k]!;
    if (n.t === 'br') {
      prevEndsSpace = true;
      stripEnd(out, k - 1);
      continue;
    }
    if (prevEndsSpace) stripStart(n);
    prevEndsSpace = endsWithSpace(n);
  }
  stripEnd(out, out.length - 1);
  return out.filter((n) => !(n.t === 'text' && n.v === ''));
}

function endsWithSpace(n: RichInline): boolean {
  if (n.t === 'text') return n.v.endsWith(' ') || n.v === '';
  if (n.t === 'br') return true;
  const last = n.c[n.c.length - 1];
  return last ? endsWithSpace(last) : false;
}

function stripStart(n: RichInline): void {
  if (n.t === 'text') n.v = n.v.replace(/^ +/, '');
  else if (n.t !== 'br' && n.c[0]) stripStart(n.c[0]);
}

function stripEnd(list: RichInline[], k: number): void {
  const n = list[k];
  if (!n) return;
  if (n.t === 'text') n.v = n.v.replace(/ +$/, '');
  else if (n.t !== 'br') stripEnd(n.c, n.c.length - 1);
}

/** Leading and trailing line breaks say nothing. */
function trimBreaks(nodes: RichInline[]): RichInline[] {
  let a = 0;
  let b = nodes.length;
  while (a < b && nodes[a]!.t === 'br') a++;
  while (b > a && nodes[b - 1]!.t === 'br') b--;
  return nodes.slice(a, b);
}

function hasText(nodes: RichInline[]): boolean {
  return nodes.some((n) =>
    n.t === 'text' ? n.v.trim().length > 0 : n.t === 'br' ? false : hasText(n.c),
  );
}

/* ------------------------------------------------------------------ HTML */

function attr(node: P5Node, name: string): string | undefined {
  return node.attrs?.find((a) => a.name === name)?.value;
}

/** The inline content of nodes, whatever blocks they contain flattened into it. */
function inlinesOf(nodes: P5Node[] | undefined, pre = false): RichInline[] {
  const out: RichInline[] = [];
  for (const node of nodes ?? []) {
    if (node.nodeName === '#text') {
      const v = node.value ?? '';
      if (pre) {
        const lines = v.split('\n');
        lines.forEach((line, k) => {
          if (k > 0) out.push({ t: 'br' });
          if (line) out.push({ t: 'text', v: line.replace(/\s+/g, '\u00a0') });
        });
      } else out.push({ t: 'text', v });
      continue;
    }
    const tag = node.tagName?.toLowerCase();
    if (!tag || DROP.has(tag)) continue;
    if (tag === 'br') {
      out.push({ t: 'br' });
      continue;
    }
    const mark = MARKS[tag];
    if (mark) {
      out.push({ t: mark, c: inlinesOf(node.childNodes, pre) });
      continue;
    }
    if (tag === 'a') {
      const href = safeHref(attr(node, 'href'));
      const c = inlinesOf(node.childNodes, pre);
      out.push(...(href ? [{ t: 'a' as const, href, c }] : c));
      continue;
    }
    // A block inside inline content (a paragraph inside bold) is its text,
    // set off by a space so its words do not run into its neighbours'.
    if (BLOCKS.has(tag)) out.push({ t: 'text', v: ' ' });
    out.push(...inlinesOf(node.childNodes, pre || tag === 'pre'));
    if (BLOCKS.has(tag)) out.push({ t: 'text', v: ' ' });
  }
  return out;
}

/**
 * The blocks of a run of nodes. Inline content between blocks collects into
 * paragraphs of its own, and two line breaks in a row - the paragraph break
 * of a description written with `<br /><br />` - end one paragraph and
 * start the next.
 */
function blocksOf(nodes: P5Node[] | undefined, out: RichBlock[]): void {
  let run: P5Node[] = [];
  const flush = () => {
    if (run.length === 0) return;
    // Split the run at double breaks.
    const inl = inlinesOf(run);
    run = [];
    let para: RichInline[] = [];
    const emit = () => {
      const c = trimBreaks(tidy(para));
      if (hasText(c)) out.push({ t: 'p', c });
      para = [];
    };
    for (let k = 0; k < inl.length; k++) {
      const n = inl[k]!;
      if (n.t === 'br') {
        // Whitespace between two breaks does not keep them apart.
        let j = k + 1;
        while (j < inl.length && inl[j]!.t === 'text' && !(inl[j] as { v: string }).v.trim()) j++;
        if (inl[j]?.t === 'br') {
          emit();
          k = j;
          continue;
        }
      }
      para.push(n);
    }
    emit();
  };

  for (const node of nodes ?? []) {
    const tag = node.nodeName === '#text' ? null : node.tagName?.toLowerCase();
    if (!tag || !BLOCKS.has(tag)) {
      if (tag && DROP.has(tag)) continue;
      run.push(node);
      continue;
    }
    flush();
    if (out.length >= MAX_BLOCKS) return;
    switch (tag) {
      case 'ul':
      case 'ol': {
        const items: RichBlock[][] = [];
        for (const li of node.childNodes ?? []) {
          if (li.nodeName === '#text' && !li.value?.trim()) continue;
          const b: RichBlock[] = [];
          blocksOf(li.nodeName === 'li' ? li.childNodes : [li], b);
          if (b.length) items.push(b);
        }
        if (items.length) out.push({ t: tag, items });
        break;
      }
      case 'blockquote': {
        const c: RichBlock[] = [];
        blocksOf(node.childNodes, c);
        if (c.length) out.push({ t: 'quote', c });
        break;
      }
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6': {
        const c = trimBreaks(tidy(inlinesOf(node.childNodes)));
        if (hasText(c)) out.push({ t: 'h', c });
        break;
      }
      case 'hr':
        out.push({ t: 'hr' });
        break;
      case 'pre': {
        const c = trimBreaks(tidy(inlinesOf(node.childNodes, true)));
        if (hasText(c)) out.push({ t: 'p', c });
        break;
      }
      default:
        blocksOf(node.childNodes, out);
    }
  }
  flush();
}

/** A description written as HTML. */
export function htmlToRich(html: string): RichBlock[] {
  const fragment = parseFragment(html.slice(0, MAX_INPUT)) as unknown as P5Node;
  const out: RichBlock[] = [];
  blocksOf(fragment.childNodes, out);
  return settle(out);
}

/* -------------------------------------------------------------- Markdown */

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  mdash: '\u2014',
  ndash: '\u2013',
  hellip: '\u2026',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
  laquo: '\u00ab',
  raquo: '\u00bb',
  bull: '\u2022',
  middot: '\u00b7',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  deg: '\u00b0',
};

/** The character references a plain-text description still carries: numeric ones, and the common names. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === '#') {
      const code =
        ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return NAMED[ref.toLowerCase()] ?? whole;
  });
}

/**
 * Inline Markdown: bold, italic, strikethrough, code and links. Underscores
 * inside a word (snake_case) are not emphasis.
 */
function mdInline(text: string): RichInline[] {
  const out: RichInline[] = [];
  const pattern =
    /(\*\*|__)(?=\S)([\s\S]+?)(?<=\S)\1|(\*|_)(?=\S)([\s\S]+?)(?<=\S)\3(?![\w*])|~~(?=\S)([\s\S]+?)(?<=\S)~~|`([^`]+)`|\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"]*")?\)|<(https?:\/\/[^>\s]+)>/g;
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    const at = m.index!;
    // `_x_` only counts at word edges.
    if (m[3] === '_' && at > 0 && /\w/.test(text[at - 1]!)) continue;
    if (at > last) out.push({ t: 'text', v: text.slice(last, at) });
    if (m[2] !== undefined) out.push({ t: 'b', c: mdInline(m[2]) });
    else if (m[4] !== undefined) out.push({ t: 'i', c: mdInline(m[4]) });
    else if (m[5] !== undefined) out.push({ t: 's', c: mdInline(m[5]) });
    else if (m[6] !== undefined) out.push({ t: 'code', c: [{ t: 'text', v: m[6] }] });
    else if (m[7] !== undefined) {
      const href = safeHref(m[8]);
      const c = mdInline(m[7]);
      out.push(...(href ? [{ t: 'a' as const, href, c }] : c));
    } else if (m[9] !== undefined) {
      const href = safeHref(m[9]);
      out.push(href ? { t: 'a', href, c: [{ t: 'text', v: m[9] }] } : { t: 'text', v: m[0] });
    }
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) });
  return out;
}

/** Lines of one paragraph, each on its own line as it was written. */
function mdParagraph(lines: string[]): RichInline[] {
  const out: RichInline[] = [];
  lines.forEach((line, k) => {
    if (k > 0) out.push({ t: 'br' });
    out.push(...mdInline(line.trim()));
  });
  return trimBreaks(tidy(out));
}

/** A description written as Markdown, or as plain text with blank lines between its paragraphs. */
export function markdownToRich(text: string): RichBlock[] {
  const lines = decodeEntities(text.slice(0, MAX_INPUT)).replace(/\r\n?/g, '\n').split('\n');
  const out: RichBlock[] = [];
  let para: string[] = [];
  let list: { t: 'ul' | 'ol'; items: RichBlock[][] } | null = null;
  let quote: string[] = [];
  const endPara = () => {
    if (para.length) {
      const c = mdParagraph(para);
      if (hasText(c)) out.push({ t: 'p', c });
    }
    para = [];
  };
  const endList = () => {
    if (list?.items.length) out.push(list);
    list = null;
  };
  const endQuote = () => {
    if (quote.length) {
      const c = markdownToRich(quote.join('\n'));
      if (c.length) out.push({ t: 'quote', c });
    }
    quote = [];
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const quoted = /^\s{0,3}>\s?(.*)$/.exec(line);
    if (quoted) {
      endPara();
      endList();
      quote.push(quoted[1]!);
      continue;
    }
    endQuote();
    if (!line.trim()) {
      endPara();
      endList();
      continue;
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*$/.exec(line);
    if (heading) {
      endPara();
      endList();
      const c = mdParagraph([heading[1]!]);
      if (hasText(c)) out.push({ t: 'h', c });
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      endPara();
      endList();
      out.push({ t: 'hr' });
      continue;
    }
    const bullet = /^\s{0,3}[-*+\u2022]\s+(.*)$/.exec(line);
    const numbered = /^\s{0,3}\d{1,3}[.)]\s+(.*)$/.exec(line);
    const item = bullet ?? numbered;
    if (item) {
      endPara();
      const kind = bullet ? 'ul' : 'ol';
      if (!list || list.t !== kind) {
        endList();
        list = { t: kind, items: [] };
      }
      const c = mdParagraph([item[1]!]);
      if (hasText(c)) list.items.push([{ t: 'p', c }]);
      continue;
    }
    // A line that follows a list item without a blank line continues it.
    if (list && list.items.length && /^\s{2,}\S/.test(raw)) {
      const lastItem = list.items[list.items.length - 1]!;
      const p = lastItem[lastItem.length - 1];
      if (p && p.t === 'p') p.c.push({ t: 'text', v: ' ' }, ...mdInline(line.trim()));
      continue;
    }
    endList();
    para.push(line);
  }
  endQuote();
  endPara();
  endList();
  return settle(out);
}

/* --------------------------------------------------------------- the lot */

function settle(blocks: RichBlock[]): RichBlock[] {
  return blocks.slice(0, MAX_BLOCKS);
}

/**
 * A description as blocks, however it was written; null when there is no
 * text in it at all.
 */
export function richDescription(text: string | null | undefined): RichBlock[] | null {
  if (!text || !text.trim()) return null;
  const blocks = looksLikeHtml(text) ? htmlToRich(text) : markdownToRich(text);
  return blocks.length ? blocks : null;
}

/** The words of blocks, for a place that can only take text (a link preview). */
export function richToPlain(blocks: RichBlock[]): string {
  const inline = (c: RichInline[]): string =>
    c.map((n) => (n.t === 'text' ? n.v : n.t === 'br' ? ' ' : inline(n.c))).join('');
  const block = (b: RichBlock): string => {
    if (b.t === 'hr') return '';
    if ('items' in b) return b.items.map((item) => item.map(block).join(' ')).join(' ');
    if (b.t === 'quote') return b.c.map(block).join(' ');
    return inline(b.c);
  };
  return blocks
    .map(block)
    .filter(Boolean)
    .join('\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}
