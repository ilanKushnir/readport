import { describe, expect, it } from 'vitest';
import { type RichBlock } from '@readport/shared';
import {
  decodeEntities,
  htmlToRich,
  looksLikeHtml,
  markdownToRich,
  richDescription,
  richToPlain,
  safeHref,
} from './rich-text.js';

/**
 * Descriptions, as files write them. Every book, author and word here is
 * invented; the shapes are the real ones - an unclosed paragraph, breaks
 * standing in for paragraphs, an entity still escaped inside the HTML.
 */

const text = (v: string) => ({ t: 'text' as const, v });

describe('descriptions written as HTML', () => {
  it('keeps paragraphs, emphasis and entities, and drops the tags', () => {
    const blocks = htmlToRich(
      "<p><b>A keeper's handbook for the long nights.</b><p>In her #1 <i>Harbor Gazette</i> bestseller, " +
        '<i>The Lantern of Ash Harbor</i>, Rivka Sharon wrote what the fog taught her.' +
        '<br /><br />Hailed as &quot;a lamp for anyone at sea,&quot; it begins with the small habits we keep&#8212;and the tide.',
    );
    expect(blocks).toEqual<RichBlock[]>([
      { t: 'p', c: [{ t: 'b', c: [text("A keeper's handbook for the long nights.")] }] },
      {
        t: 'p',
        c: [
          text('In her #1 '),
          { t: 'i', c: [text('Harbor Gazette')] },
          text(' bestseller, '),
          { t: 'i', c: [text('The Lantern of Ash Harbor')] },
          text(', Rivka Sharon wrote what the fog taught her.'),
        ],
      },
      {
        t: 'p',
        c: [
          text(
            'Hailed as "a lamp for anyone at sea," it begins with the small habits we keep\u2014and the tide.',
          ),
        ],
      },
    ]);
  });

  it('keeps a single break as a line break, and whitespace as one space', () => {
    expect(htmlToRich('<div>First   line<br>\n  second\tline </div>')).toEqual<RichBlock[]>([
      { t: 'p', c: [text('First line'), { t: 'br' }, text('second line')] },
    ]);
  });

  it('keeps lists, headings, quotes and rules', () => {
    expect(
      htmlToRich(
        '<h2>Inside</h2><ul><li>The ledger</li><li><p>The <em>lens</em></p></li></ul>' +
          '<ol><li>First light</li></ol><blockquote><p>The lens remembers.</p></blockquote><hr/>',
      ),
    ).toEqual<RichBlock[]>([
      { t: 'h', c: [text('Inside')] },
      {
        t: 'ul',
        items: [
          [{ t: 'p', c: [text('The ledger')] }],
          [{ t: 'p', c: [text('The '), { t: 'i', c: [text('lens')] }] }],
        ],
      },
      { t: 'ol', items: [[{ t: 'p', c: [text('First light')] }]] },
      { t: 'quote', c: [{ t: 'p', c: [text('The lens remembers.')] }] },
      { t: 'hr' },
    ]);
  });

  it('keeps a link only when it goes somewhere a page may follow', () => {
    const blocks = htmlToRich(
      '<p><a href="https://example.org/ash">Ash Harbor</a> and <a href="javascript:alert(1)">not this</a></p>',
    );
    expect(blocks).toEqual<RichBlock[]>([
      {
        t: 'p',
        c: [
          { t: 'a', href: 'https://example.org/ash', c: [text('Ash Harbor')] },
          text(' and not this'),
        ],
      },
    ]);
  });

  it('lets nothing that could run through, and keeps no attribute', () => {
    const blocks = htmlToRich(
      '<p onclick="steal()">Safe <img src=x onerror="steal()"><script>steal()</script>' +
        '<style>p{}</style><span style="color:red">words</span><iframe src="https://example.org"></iframe></p>',
    );
    expect(blocks).toEqual<RichBlock[]>([{ t: 'p', c: [text('Safe words')] }]);
    expect(JSON.stringify(blocks)).not.toMatch(/steal|onerror|onclick|style/);
  });
});

describe('descriptions written as Markdown or plain text', () => {
  it('takes blank lines as paragraphs and single ones as line breaks', () => {
    expect(markdownToRich('The first paragraph.\n\nThe second,\nin two lines.')).toEqual<
      RichBlock[]
    >([
      { t: 'p', c: [text('The first paragraph.')] },
      { t: 'p', c: [text('The second,'), { t: 'br' }, text('in two lines.')] },
    ]);
  });

  it('reads emphasis, code, strikethrough and links, but not snake_case', () => {
    expect(
      markdownToRich(
        '**Bold** and *italic* and _also_ and `code` and ~~gone~~ in snake_case_word, [a link](https://example.org).',
      ),
    ).toEqual<RichBlock[]>([
      {
        t: 'p',
        c: [
          { t: 'b', c: [text('Bold')] },
          text(' and '),
          { t: 'i', c: [text('italic')] },
          text(' and '),
          { t: 'i', c: [text('also')] },
          text(' and '),
          { t: 'code', c: [text('code')] },
          text(' and '),
          { t: 's', c: [text('gone')] },
          text(' in snake_case_word, '),
          { t: 'a', href: 'https://example.org/', c: [text('a link')] },
          text('.'),
        ],
      },
    ]);
  });

  it('reads headings, lists, quotes and rules', () => {
    expect(
      markdownToRich(
        '# The keeper\n\n- ledger\n- lens\n\n1. fog\n2. light\n\n> The water forgets.\n\n---',
      ),
    ).toEqual<RichBlock[]>([
      { t: 'h', c: [text('The keeper')] },
      { t: 'ul', items: [[{ t: 'p', c: [text('ledger')] }], [{ t: 'p', c: [text('lens')] }]] },
      { t: 'ol', items: [[{ t: 'p', c: [text('fog')] }], [{ t: 'p', c: [text('light')] }]] },
      { t: 'quote', c: [{ t: 'p', c: [text('The water forgets.')] }] },
      { t: 'hr' },
    ]);
  });

  it('decodes the character references plain text still carries', () => {
    expect(decodeEntities('Keep&#8212;and tide &amp; fog &hellip; &#x2019;s &unknown;')).toBe(
      'Keep\u2014and tide & fog \u2026 \u2019s &unknown;',
    );
  });

  it('turns a link it cannot follow back into its text', () => {
    expect(markdownToRich('[click](javascript:alert(1))')).toEqual<RichBlock[]>([
      { t: 'p', c: [text('click')] },
    ]);
  });
});

describe('richDescription', () => {
  it('tells HTML from text, and gives nothing for an empty description', () => {
    expect(looksLikeHtml('<p>Words</p>')).toBe(true);
    expect(looksLikeHtml('Fish & chips < 3 pounds')).toBe(false);
    expect(richDescription('  ')).toBeNull();
    expect(richDescription('<p> </p>')).toBeNull();
    expect(richDescription('Fish & chips < 3 pounds')).toEqual([
      { t: 'p', c: [text('Fish & chips < 3 pounds')] },
    ]);
  });

  it('gives the words back as plain text for a link preview', () => {
    const blocks = htmlToRich('<p><b>Bold</b> start.</p><ul><li>One</li><li>Two</li></ul>');
    expect(richToPlain(blocks)).toBe('Bold start.\n\nOne Two');
  });

  it('only lets http, https and mailto addresses through', () => {
    expect(safeHref('https://example.org')).toBe('https://example.org/');
    expect(safeHref('mailto:keeper@example.org')).toBe('mailto:keeper@example.org');
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('data:text/html,hi')).toBeNull();
    expect(safeHref('/relative')).toBeNull();
  });
});
