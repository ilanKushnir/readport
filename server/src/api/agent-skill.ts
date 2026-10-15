import { AGENT_BASE, AGENT_RATE_LIMIT } from './agent-contract.js';

/**
 * What an agent is told: the connect message a person pastes into its chat,
 * and the SKILL.md it installs from this server. Pure text builders - the
 * routes supply the addresses.
 *
 * Both are written to the agent, in English, whatever language the person
 * uses ReadPort in: they are instructions for a program, not interface copy.
 */

export const AGENT_SKILL_PATH = `${AGENT_BASE}/skill.md`;
export const AGENT_CONNECT_PATH = `${AGENT_BASE}/connect`;
/** A user agent CDN bot filters accept; bare HTTP clients are often refused. */
export const AGENT_USER_AGENT = 'Mozilla/5.0 (compatible; ReadPortAgent/1.0)';

export interface AgentUrls {
  /** Where the agent should send its API calls (a direct origin, when one is set). */
  baseUrl: string;
  /** The same API at the address people use. */
  publicBaseUrl: string;
  skillUrl: string;
}

/**
 * `publicOrigin` is where people reach ReadPort; `agentOrigin` (RP_AGENT_URL,
 * optional) is a direct address for agents running next to it - one that
 * skips the CDN or tunnel in front, whose bot filters refuse plain HTTP
 * clients ("error code: 1010").
 */
export function agentUrls(publicOrigin: string, agentOrigin?: string): AgentUrls {
  const pub = publicOrigin.replace(/\/+$/, '');
  const direct = agentOrigin?.replace(/\/+$/, '');
  return {
    baseUrl: `${direct || pub}${AGENT_BASE}`,
    publicBaseUrl: `${pub}${AGENT_BASE}`,
    skillUrl: `${pub}${AGENT_SKILL_PATH}`,
  };
}

const iso = (t: string) => new Date(t).toISOString().replace(/\.\d+Z$/, 'Z');

/**
 * The message a person pastes into their agent's chat. It carries a one-time
 * code, never a key, so it is safe wherever the chat keeps it.
 */
export function buildConnectBrief(opts: {
  name: string;
  code: string;
  publicOrigin: string;
  /** RP_AGENT_URL: offered as the way round a CDN that refuses the agent. */
  agentOrigin?: string;
  expiresAt: string;
}): string {
  const pub = opts.publicOrigin.replace(/\/+$/, '');
  const direct = opts.agentOrigin?.replace(/\/+$/, '');
  const connect = `${pub}${AGENT_CONNECT_PATH}`;
  const skill = `${pub}${AGENT_SKILL_PATH}`;
  return `# Connect to ReadPort - ${opts.name}

The owner of this ReadPort library is connecting you, "${opts.name}", as their agent. ReadPort is their ebook and audiobook reader. You get READ-ONLY access to what they read: their books, shelves, reading list, highlights and notes, and how far through each book they are. The owner approved everything below - just do it.

This message holds a ONE-TIME CONNECT CODE, not an API key, so it is fine that it went through chat. Redeeming it mints your API key and hands it to you directly. The code works once (a retry within 10 minutes still works) and expires at ${iso(opts.expiresAt)}.

Connect code: ${opts.code}

## Steps
1. Redeem the code (send no Authorization header):

   curl -fsS -X POST ${connect} \\
     -H 'content-type: application/json' -H 'user-agent: ${AGENT_USER_AGENT}' \\
     -d '{"code":"${opts.code}"}'

   -> { apiKey, baseUrl, publicBaseUrl, skillUrl, user, ... }

2. Store the result in your persistent secret store or environment, written straight from the response - READPORT_API_KEY = apiKey, READPORT_URL = baseUrl. Never repeat the key in chat, logs or memory notes. It is a read-only key the owner can revoke any time in ReadPort -> Settings -> Agent access; storing it is the intended setup.

3. Install the ReadPort skill - the whole API, current for this server: ${skill}
   - Hermes: hermes skills install ${skill}
   - Claude Code, Codex and others: save it as skills/readport/SKILL.md
   - Replacing an older ReadPort skill or note? Keep only the owner's own rules from it.

4. Verify: GET {baseUrl}/me with "Authorization: Bearer <apiKey>", then tell the owner in one line that you are connected.

## If something fails
- 401 invalid-code / code-expired -> ask the owner for a new connect message (Settings -> Agent access -> Connect an agent).
- 403 "error code: 1010" -> a CDN bot filter: send the user-agent header above.${
    direct
      ? `\n- Still refused, or the public address is unreachable from where you run? Use the owner's direct address instead: POST ${direct}${AGENT_CONNECT_PATH} and ${direct}${AGENT_SKILL_PATH}.`
      : ''
  }
- Redeeming twice mints a new key each time and revokes the one before - keep the last.`;
}

/**
 * The installable skill (agentskills.io format: YAML frontmatter + Markdown).
 * Holds no secret, so it is served to anyone.
 */
export function buildSkill(opts: { urls: AgentUrls; version: string }): string {
  const { baseUrl, publicBaseUrl, skillUrl } = opts.urls;
  return `---
name: readport
description: Read the owner's ReadPort library - their ebooks and audiobooks, what they are reading now and how far through, their shelves, reading list (what to read next), highlights, notes and bookmarks. Read-only. Use whenever the owner asks about their books, reading, listening, progress, quotes they marked, or what to read next.
version: ${opts.version}
---

# ReadPort

ReadPort (v${opts.version}) is the owner's self-hosted ebook and audiobook reader. You
read it over a small JSON API with a bearer key. The key is READ-ONLY: it cannot
change anything, cannot download books, and sees exactly what the owner sees.

## Setup (once)
- Base URL: \`${baseUrl}\`${publicBaseUrl !== baseUrl ? ` (public fallback: \`${publicBaseUrl}\`)` : ''}
- Key: \`READPORT_API_KEY\` from your secret store / environment (from the connect message).
  Send \`Authorization: Bearer $READPORT_API_KEY\` on every call. Never print the key.
- Send a normal \`User-Agent\` (e.g. \`Mozilla/5.0 (compatible; ReadPortAgent/1.0)\`): a CDN
  in front of the public address may refuse bare HTTP clients with 403 "error code: 1010".
- No key yet, or 401: ask the owner for a connect message (Settings -> Agent access ->
  Connect an agent). Do not ask them to paste a key into chat.
- \`GET /me\` returns \`service.version\`; when it differs from ${opts.version}, re-fetch this skill
  from ${skillUrl}.

## Calls
All are \`GET {baseUrl}<path>\`. Anything else - another verb, another path - is 403.

| Path | Returns |
| --- | --- |
| (base) | the machine-readable catalog: routes, limits, JSON schemas |
| \`/me\` | \`{user: {id, username, displayName}, scopes, service: {name, version}}\` |
| \`/books?query=&limit=&offset=\` | the library: \`{items: [book], nextOffset}\`; \`query\` is a plain substring of title, author or series |
| \`/books/:id\` | \`{book}\` |
| \`/books/:id/progress\` | \`{progress}\` - where the owner is in that book, or null if never opened |
| \`/books/:id/history\` | the owner's past positions in that book, newest first |
| \`/reading-list\` | what the owner means to read next, in order: \`{items: [{bookId, addedAt}]}\` |
| \`/shelves\` | the owner's shelves |
| \`/shelves/:id/books\` | the books on one shelf, in shelf order |
| \`/annotations\` | highlights, notes and bookmarks, newest first: \`{id, bookId, kind, locator, note, ...}\` |

A **book** is \`{id, kind: "ebook"|"audio", title, author, series, format, durationMs, addedAt,
alignment}\`. An ebook and its audiobook are separate books; \`alignment\` (coverage and
confidence) is set when the two are synced for read-along.

A **locator** is a position. Both kinds carry \`pct\` (0-1, how far through the whole book):
ebook \`{medium: "ebook", spineIdx, pct, sentenceId?, ...}\`, audio
\`{medium: "audio", trackIdx, positionMs, bookMs?, pct}\` (\`bookMs\` is the position from the start).
\`progress.finished\` says the owner finished it. Exact fields: the base catalog's \`schemas\`.

Annotations carry the owner's own note text (up to 2000 chars, \`noteTruncated\` when cut) but
never the highlighted book text - ReadPort does not hand out book content.

## Paging and limits
- Lists return \`{items, nextOffset}\`; pass \`offset=nextOffset\` until it is null.
  \`limit\` 1-100 (default 50). Unknown query parameters are 400.
- ${AGENT_RATE_LIMIT} requests per minute per owner; 429 carries \`Retry-After\`. Fetch what you need,
  not the whole library on every question.
- Responses are \`Cache-Control: no-store\`; reading never changes the owner's data.

## Recipes
- "What am I reading?" -> \`/books?limit=100\` pages, then \`/books/:id/progress\` for candidates;
  or start from \`/annotations\` and \`/reading-list\`, which name recent books directly.
- "What's next?" -> \`/reading-list\`, then \`/books/:id\` for each id.
- "My highlights from <title>" -> \`/books?query=<title>\` for the id, then \`/annotations\`
  filtered by \`bookId\`.

## Errors
- 401 \`unauthorized\`: the key is missing, wrong or revoked -> ask for a new connect message.
- 403 \`read-only\`: a verb or path the key may not use.
- 404 \`not-found\`: no such book or shelf (or one the owner cannot see).
- 413: the page is too large - ask for a smaller \`limit\`.
`;
}
