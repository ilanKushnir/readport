/**
 * The share page as a crawler sees it.
 *
 * WhatsApp, Telegram, Slack and iMessage fetch a link without cookies and
 * without running a line of JavaScript, so the preview they show has to be
 * in the HTML itself: the built app shell, with Open Graph tags for the book
 * spliced in before `</head>`. Everything spliced in comes from the library's
 * metadata - a title is untrusted text like any other - so every value is
 * escaped for an attribute.
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface OpenGraphBook {
  title: string;
  description: string;
  url: string;
  image: string;
  imageWidth: number;
  imageHeight: number;
}

/** The static app tags in index.html, which a book page replaces rather than joins. */
const STATIC_SOCIAL_META =
  /^[ \t]*<meta\s+(?:property|name)="(?:og|twitter):[^"]*"[^>]*>[ \t]*\r?\n/gm;

export function openGraphTags(book: OpenGraphBook): string {
  const tags: [string, string][] = [
    ['og:type', 'book'],
    ['og:site_name', 'ReadPort'],
    ['og:title', book.title],
    ['og:description', book.description],
    ['og:url', book.url],
    ['og:image', book.image],
    ['og:image:type', 'image/png'],
    ['og:image:width', String(book.imageWidth)],
    ['og:image:height', String(book.imageHeight)],
    ['twitter:card', 'summary_large_image'],
    ['twitter:title', book.title],
    ['twitter:description', book.description],
    ['twitter:image', book.image],
  ];
  return tags
    .map(([property, content]) =>
      property.startsWith('twitter:')
        ? `<meta name="${property}" content="${escapeHtml(content)}" />`
        : `<meta property="${property}" content="${escapeHtml(content)}" />`,
    )
    .join('\n    ');
}

/**
 * The app shell with this book's preview tags in place of the app's own.
 * The document title follows too, for the readers that fall back to it. A
 * shell with no `</head>` (which the built one always has) is returned as
 * it is rather than guessed at.
 */
export function injectOpenGraph(indexHtml: string, book: OpenGraphBook): string {
  const at = indexHtml.indexOf('</head>');
  if (at < 0) return indexHtml;
  const head = indexHtml
    .slice(0, at)
    .replace(STATIC_SOCIAL_META, '')
    .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(book.title)} · ReadPort</title>`);
  return `${head}    ${openGraphTags(book)}\n  ${indexHtml.slice(at)}`;
}
