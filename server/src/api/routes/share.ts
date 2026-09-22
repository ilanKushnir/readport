import fs from 'node:fs';
import path from 'node:path';
import { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  joinRequestSchema,
  joinStatusQuerySchema,
  sharePath,
  type CreateShareResponse,
  type SharePeek,
} from '@readport/shared';
import { type AppContext } from '../../context.js';
import { LoginThrottle } from '../../auth/sessions.js';
import {
  activeShare,
  countShareOpen,
  createJoinRequest,
  existingShare,
  getOrCreateShare,
  joinStatus,
  publicBase,
  revokeShare,
  sharedBookOf,
  type ActiveShare,
} from '../../share/service.js';
import { injectOpenGraph } from '../../share/html.js';
import {
  SHARE_IMAGE_HEIGHT,
  SHARE_IMAGE_WIDTH,
  cachedShareImage,
  forgetShareImage,
  readCover,
  renderShareImage,
} from '../../share/image.js';
import { queueBook } from './shelves.js';

/**
 * Share links.
 *
 * `/s/<token>` is the one place ReadPort answers a stranger with something
 * about a book: the title, the author, the cover and who shared it - the
 * teaser a link preview shows and the page the person lands on. Everything
 * under it is public on purpose and rate limited per address; the token is
 * 192 bits of randomness and the only credential. What it never says is
 * anything about the sharer's account beyond a display name, or anything
 * about the library beyond this one book.
 *
 * The HTML and the image are the deliberate exceptions to "private,
 * no-store": they are the same bytes for everyone, and a crawler that
 * fetches a preview twice should be served from cache.
 */

/** A request through a link, per address: one preview is two of these. */
const PAGE_LIMIT = 120;
const PAGE_WINDOW_MS = 60_000;
/** Asking to join, per address and per email address. */
const JOIN_LIMIT_PER_IP = 10;
const JOIN_LIMIT_PER_EMAIL = 5;
const JOIN_WINDOW_MS = 10 * 60_000;
/** Checking on a request, per address: the page does it once a visit. */
const STATUS_LIMIT = 60;
const STATUS_WINDOW_MS = 10 * 60_000;
/** How long a browser or a shared cache may keep the page and its picture. */
const HTML_MAX_AGE = 300;
const IMAGE_MAX_AGE = 3600;

export function registerShareRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  opts: { webDist?: string } = {},
): void {
  const { db, config } = ctx;
  const pageThrottle = new LoginThrottle(db, PAGE_LIMIT, PAGE_WINDOW_MS);
  const joinIpThrottle = new LoginThrottle(db, JOIN_LIMIT_PER_IP, JOIN_WINDOW_MS);
  const joinEmailThrottle = new LoginThrottle(db, JOIN_LIMIT_PER_EMAIL, JOIN_WINDOW_MS);
  const statusThrottle = new LoginThrottle(db, STATUS_LIMIT, STATUS_WINDOW_MS);
  const indexHtml = opts.webDist ? path.join(opts.webDist, 'index.html') : null;

  const tooMany = (reply: FastifyReply) =>
    reply.header('retry-after', '60').code(429).send({ error: 'rate-limited' });
  const tokenOf = (req: FastifyRequest) => (req.params as { token: string }).token;
  const absolute = (req: FastifyRequest, share: ActiveShare, suffix = '') =>
    `${publicBase(db, config, req)}${sharePath(share.token)}${suffix}`;
  const imageFor = (share: ActiveShare) =>
    cachedShareImage(share.token, () =>
      renderShareImage({
        bookId: share.bookId,
        title: share.title,
        author: share.author,
        cover: readCover(share.coverPath),
      }),
    );

  /* --------------------------------------------------------- signed in */

  /**
   * The caller's live share for this book, made on first ask. The shape is
   * a contract - the reader shares a quotation through the same call - so
   * it is exactly `{url, token}`.
   */
  app.post('/api/books/:id/share', async (req, reply) => {
    const { id } = req.params as { id: string };
    const book = db.prepare("SELECT 1 FROM books WHERE id = ? AND scan_state != 'missing'").get(id);
    if (!book) return reply.code(404).send({ error: 'not-found' });
    const token = getOrCreateShare(db, id, req.user!.id);
    const share = activeShare(db, token);
    if (!share) return reply.code(404).send({ error: 'not-found' });
    const body: CreateShareResponse = { url: absolute(req, share), token };
    return body;
  });

  /**
   * The caller's link for this book if one is live, without making one:
   * the share menu asks this on opening, so that looking at the menu is not
   * the same as handing out a link.
   */
  app.get('/api/books/:id/share', async (req, reply) => {
    const { id } = req.params as { id: string };
    const book = db.prepare("SELECT 1 FROM books WHERE id = ? AND scan_state != 'missing'").get(id);
    if (!book) return reply.code(404).send({ error: 'not-found' });
    const token = existingShare(db, id, req.user!.id);
    const share = token ? activeShare(db, token) : null;
    return share ? { url: absolute(req, share), token: share.token } : { url: null, token: null };
  });

  /** Revoke: the creator, or an admin. A miss is a 404 so a token cannot be probed. */
  app.delete('/api/share/:token', async (req, reply) => {
    const token = tokenOf(req);
    if (!revokeShare(db, token, req.user!)) return reply.code(404).send({ error: 'not-found' });
    forgetShareImage(token);
    return { ok: true };
  });

  /**
   * The shared book onto the caller's reading list, credited to the sharer.
   * Here rather than through the reading-list API because the public teaser
   * never names the sharer's id - the server knows who it was.
   */
  app.post('/api/share/:token/add', async (req, reply) => {
    const share = activeShare(db, tokenOf(req));
    if (!share) return reply.code(404).send({ error: 'invalid-share' });
    const me = req.user!.id;
    const recommendedBy = share.createdBy === me ? null : share.createdBy;
    const { added } = queueBook(db, me, share.bookId, recommendedBy);
    return { added, bookId: share.bookId };
  });

  /* ------------------------------------------------------------ public */

  /** The teaser. `{valid: false}` for a token that is unknown or revoked, never why. */
  app.get('/api/share/:token', { config: { public: true } }, async (req, reply) => {
    if (!pageThrottle.allow(`share:${req.clientIp}`)) return tooMany(reply);
    const share = activeShare(db, tokenOf(req));
    const body: SharePeek = share
      ? { valid: true, book: sharedBookOf(share), sharedBy: { displayName: share.sharerName } }
      : { valid: false };
    return body;
  });

  /** Ask to join. One open request per address; asking again is the same answer. */
  app.post('/api/share/:token/join', { config: { public: true } }, async (req, reply) => {
    if (!joinIpThrottle.allow(`join:${req.clientIp}`)) return tooMany(reply);
    const share = activeShare(db, tokenOf(req));
    if (!share) return reply.code(404).send({ error: 'invalid-share' });
    const parsed = joinRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid', detail: parsed.error.issues[0]?.message });
    }
    if (!joinEmailThrottle.allow(`join-email:${parsed.data.email}`)) return tooMany(reply);
    const result = createJoinRequest(db, { ...parsed.data, shareToken: share.token });
    if (result.created) {
      ctx.log.info(`Join request left through a share link for "${share.title}"`);
    }
    return reply.code(result.created ? 201 : 200).send({ status: result.status });
  });

  /**
   * Where a request stands, by the address the page remembers. The invite
   * code is in the answer only while the request is approved and its
   * invitation still open, and only on the link the request came through.
   */
  app.get('/api/share/:token/join', { config: { public: true } }, async (req, reply) => {
    if (!statusThrottle.allow(`join-status:${req.clientIp}`)) return tooMany(reply);
    const share = activeShare(db, tokenOf(req));
    if (!share) return reply.code(404).send({ error: 'invalid-share' });
    const parsed = joinStatusQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid' });
    return joinStatus(db, config.sessionSecret, parsed.data.email, share.token);
  });

  /**
   * The page itself, for the crawlers: the app shell with this book's Open
   * Graph tags in the head. A token that resolves to nothing gets the shell
   * unchanged, and the app then says the link is no longer valid.
   */
  app.get('/s/:token', { config: { public: true } }, async (req, reply) => {
    if (!pageThrottle.allow(`share:${req.clientIp}`)) return tooMany(reply);
    if (!indexHtml || !fs.existsSync(indexHtml)) {
      return reply
        .code(503)
        .type('text/plain')
        .send('ReadPort web assets are not built. Run: npm run build');
    }
    const html = fs.readFileSync(indexHtml, 'utf8');
    const share = activeShare(db, tokenOf(req));
    reply.type('text/html; charset=utf-8');
    if (!share) return reply.header('cache-control', 'no-cache').send(html);
    countShareOpen(db, share.token);
    reply.header('cache-control', `public, max-age=${HTML_MAX_AGE}`);
    return reply.send(
      injectOpenGraph(html, {
        title: share.title,
        description: `${share.author ? `${share.author} · ` : ''}Shared with you on ReadPort`,
        url: absolute(req, share),
        image: absolute(req, share, '/image.png'),
        imageWidth: SHARE_IMAGE_WIDTH,
        imageHeight: SHARE_IMAGE_HEIGHT,
      }),
    );
  });

  /** The preview picture: rendered once an hour per token, cacheable by anyone. */
  app.get('/s/:token/image.png', { config: { public: true } }, async (req, reply) => {
    if (!pageThrottle.allow(`share:${req.clientIp}`)) return tooMany(reply);
    const share = activeShare(db, tokenOf(req));
    if (!share) return reply.code(404).send({ error: 'not-found' });
    reply.header('content-type', 'image/png');
    reply.header('cache-control', `public, max-age=${IMAGE_MAX_AGE}`);
    return reply.send(imageFor(share));
  });

  /**
   * The cover on its own, for the share page's teaser: `/api/books/:id/cover`
   * needs a session, and the person on this page may not have one yet. The
   * preview image above already shows the same picture to anyone with the
   * link, so nothing more is given away here.
   */
  app.get('/s/:token/cover', { config: { public: true } }, async (req, reply) => {
    if (!pageThrottle.allow(`share:${req.clientIp}`)) return tooMany(reply);
    const share = activeShare(db, tokenOf(req));
    const cover = share ? readCover(share.coverPath) : null;
    if (!cover) return reply.code(404).send({ error: 'no-cover' });
    reply.header('content-type', cover.mime);
    if (cover.mime === 'image/svg+xml') {
      reply.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'");
    }
    reply.header('cache-control', `public, max-age=${IMAGE_MAX_AGE}`);
    return reply.send(cover.data);
  });
}
