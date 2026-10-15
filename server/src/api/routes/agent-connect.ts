import { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type AppContext } from '../../context.js';
import { nowIso } from '../../db/index.js';
import {
  CONNECT_PENDING_LIMIT,
  connectStatus,
  issueConnectCode,
  pendingCodes,
  redeemConnectCode,
  type ConnectCodeRow,
} from '../../auth/connect.js';
import { publicBase } from '../../share/service.js';
import { APP_VERSION } from '../../util/version.js';
import {
  AGENT_CONNECT_PATH,
  AGENT_SKILL_PATH,
  agentUrls,
  buildConnectBrief,
  buildSkill,
} from '../agent-skill.js';
import { allowAgentConnect } from './agent.js';

/**
 * Connecting an agent, both halves.
 *
 * The person's half (session only - a key cannot reach /api/keys at all):
 * make a code and the message that carries it, watch it get used, cancel it.
 * The agent's half (no session, no key): trade the code for a key, and fetch
 * the skill that explains the API. See auth/connect.ts.
 */

const createSchema = z.object({
  name: z.string().trim().min(1, 'Give it a name').max(60),
});
const redeemSchema = z.object({ code: z.string().max(200) });

/** Live keys a person may hold; the same cap creating one by hand meets. */
const KEY_LIMIT = 20;

export function registerAgentConnectRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, config } = ctx;
  const liveKeys = (userId: string) =>
    (
      db
        .prepare('SELECT COUNT(*) AS c FROM api_keys WHERE user_id = ? AND revoked_at IS NULL')
        .get(userId) as { c: number }
    ).c;

  app.post('/api/keys/connect', async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid', message: parsed.error.issues[0]?.message });
    }
    const userId = req.user!.id;
    const now = nowIso();
    if (liveKeys(userId) >= KEY_LIMIT) return reply.code(409).send({ error: 'too-many-keys' });
    if (pendingCodes(db, userId, now).length >= CONNECT_PENDING_LIMIT) {
      return reply.code(409).send({ error: 'too-many-pending' });
    }
    const { id, code, expiresAt } = issueConnectCode(db, {
      userId,
      name: parsed.data.name,
      now,
    });
    // The code exists in the clear here and in the message, nowhere else.
    return {
      connect: {
        id,
        name: parsed.data.name,
        expiresAt,
        brief: buildConnectBrief({
          name: parsed.data.name,
          code,
          publicOrigin: publicBase(db, config, req),
          agentOrigin: config.agentUrl,
          expiresAt,
        }),
      },
    };
  });

  app.get('/api/keys/connect/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db
      .prepare('SELECT * FROM agent_connect_codes WHERE id = ? AND user_id = ?')
      .get(id, req.user!.id) as ConnectCodeRow | undefined;
    if (!row) return reply.code(404).send({ error: 'not-found' });
    return { status: connectStatus(row, nowIso()), apiKeyId: row.api_key_id };
  });

  app.delete('/api/keys/connect/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const res = db
      .prepare(
        `UPDATE agent_connect_codes SET cancelled_at = ?
         WHERE id = ? AND user_id = ? AND redeemed_at IS NULL AND cancelled_at IS NULL`,
      )
      .run(nowIso(), id, req.user!.id);
    if (Number(res.changes) === 0) return reply.code(404).send({ error: 'not-found' });
    return { ok: true };
  });

  // The agent's half. Public: the code is the credential, and the skill holds
  // no secret. CSRF-exempt because neither acts on a browser's cookies - the
  // redemption looks at the code and nothing else.
  app.post(
    AGENT_CONNECT_PATH,
    { config: { public: true, csrfExempt: true }, bodyLimit: 1024 },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      if (!allowAgentConnect(db, req.clientIp ?? req.ip)) {
        return reply.header('retry-after', '60').code(429).send({ error: 'rate-limited' });
      }
      const parsed = redeemSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'missing-code',
          detail: 'Send {"code":"rpc_..."} from the connect message.',
        });
      }
      const result = redeemConnectCode(db, parsed.data.code, nowIso());
      if (!result.ok) {
        return reply.code(401).send({
          error: result.error,
          detail:
            result.error === 'code-expired'
              ? 'This connect code has been used or has expired. Ask the owner for a new connect message.'
              : 'Unknown connect code. Ask the owner for a new connect message.',
        });
      }
      const user = db
        .prepare('SELECT id, username, display_name FROM users WHERE id = ?')
        .get(result.userId) as { id: string; username: string; display_name: string | null };
      ctx.log.info(
        JSON.stringify({
          event: 'agent-connect',
          keyId: result.apiKeyId,
          userId: result.userId,
        }),
      );
      const urls = agentUrls(publicBase(db, config, req), config.agentUrl);
      return {
        apiKey: result.key,
        ...urls,
        service: { name: 'readport', version: APP_VERSION },
        user: { id: user.id, username: user.username, displayName: user.display_name },
        readOnly: true,
        storeAs: { apiKey: 'READPORT_API_KEY', baseUrl: 'READPORT_URL' },
        next: [
          'Store apiKey (as READPORT_API_KEY) and baseUrl (as READPORT_URL) in your persistent secret store now. Do not echo the key into chat.',
          `Install the skill: ${urls.skillUrl}`,
          "GET {baseUrl}/me with 'Authorization: Bearer <apiKey>' to verify, then tell the owner you are connected.",
        ],
      };
    },
  );

  app.get(AGENT_SKILL_PATH, { config: { public: true } }, async (req, reply) => {
    const md = buildSkill({
      urls: agentUrls(publicBase(db, config, req), config.agentUrl),
      version: APP_VERSION,
    });
    return reply.header('cache-control', 'no-cache').type('text/markdown; charset=utf-8').send(md);
  });
}
