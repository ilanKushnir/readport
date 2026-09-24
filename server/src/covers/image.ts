/**
 * What an image is, from its own bytes: the kind by its signature and its
 * size from its header. A cover fetched from another server is believed
 * about nothing - not its content type, not its extension - until these
 * agree that it is a picture a page can show, and a big enough one to be a
 * cover rather than a placeholder.
 */

/** `svg` only ever for a cover a book already has, never for one from elsewhere. */
export type ImageKind = 'jpeg' | 'png' | 'webp' | 'svg';

export interface ImageFacts {
  kind: ImageKind;
  width: number;
  height: number;
}

export const IMAGE_TYPES: Record<ImageKind, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

export const IMAGE_EXT: Record<ImageKind, string> = {
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp',
  svg: 'svg',
};

function jpegSize(b: Buffer): { width: number; height: number } | null {
  // Walk the markers to the first start-of-frame, which carries the size.
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = b[i + 1]!;
    // Standalone markers carry no length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xff) {
      i++;
      continue;
    }
    const len = b.readUInt16BE(i + 2);
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

function webpSize(b: Buffer): { width: number; height: number } | null {
  const chunk = b.toString('ascii', 12, 16);
  if (chunk === 'VP8 ' && b.length >= 30) {
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L' && b.length >= 25) {
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X' && b.length >= 30) {
    return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  }
  return null;
}

/** The kind and size of an image, or null when these bytes are not one ReadPort shows as a cover. */
export function imageFacts(b: Buffer): ImageFacts | null {
  if (b.length < 32) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    const size = jpegSize(b);
    return size ? { kind: 'jpeg', ...size } : null;
  }
  if (b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) {
    return { kind: 'png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const size = webpSize(b);
    return size ? { kind: 'webp', ...size } : null;
  }
  return null;
}

/**
 * The size an SVG says it is drawn at, from its root element: its width and
 * height, or else its viewBox. Only for a cover a book already has - an
 * EPUB's own drawn cover, offered to its other format - and never for a
 * picture from anywhere else, which has to be a photograph-kind of image.
 */
export function svgFacts(b: Buffer): ImageFacts | null {
  const tag = /<svg\b[^>]*>/i.exec(b.subarray(0, 4096).toString('utf8'))?.[0];
  if (!tag) return null;
  const size = (name: string) => {
    const m = new RegExp(`\\s${name}\\s*=\\s*["']\\s*([\\d.]+)(?:px)?\\s*["']`, 'i').exec(tag);
    return m ? Number(m[1]) : NaN;
  };
  let width = size('width');
  let height = size('height');
  if (!(width > 0 && height > 0)) {
    const box =
      /\sviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i.exec(tag);
    width = Number(box?.[1]);
    height = Number(box?.[2]);
  }
  return width > 0 && height > 0
    ? { kind: 'svg', width: Math.round(width), height: Math.round(height) }
    : null;
}

/** Smaller than this on either side is a thumbnail or a placeholder, not a cover. */
export const MIN_COVER_PX = 150;
const MAX_COVER_PX = 12_000;

/** Whether an image is fit to be a book's cover. */
export function coverWorthy(facts: ImageFacts | null): facts is ImageFacts {
  return (
    !!facts &&
    facts.width >= MIN_COVER_PX &&
    facts.height >= MIN_COVER_PX &&
    facts.width <= MAX_COVER_PX &&
    facts.height <= MAX_COVER_PX
  );
}
