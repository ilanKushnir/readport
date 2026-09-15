# Self-hosting ReadPort

ReadPort is a single Docker container (plus an optional worker) in front of
your existing libraries. Your book folders are mounted **read-only** and are
never modified. There is one deliberate exception: an alignment folder,
mounted read-write, where finished alignments are saved as files so the hours
of CPU that produced them outlive the container. Everything else ReadPort
creates lives in its own volumes.

## Quick start (Docker Compose)

```bash
git clone https://github.com/ilanKushnir/readport && cd readport
cp .env.example .env

# Required: a session secret. (Appending wins - later lines override earlier
# ones - so this works the same on macOS and Linux, with no sed dialect.)
echo "RP_SESSION_SECRET=$(openssl rand -hex 32)" >> .env

# Then point these three at your real folders, in .env. The compose file
# reads them, so it never needs editing and `git pull` stays clean:
#   RP_EBOOK_PATH=/srv/books/ebooks
#   RP_AUDIOBOOK_PATH=/srv/books/audiobooks
#   RP_ALIGNMENT_PATH=/srv/books/alignments   # writable, chown to PUID:PGID

docker compose up -d --build
```

Open `http://<host>:8383`, create the admin account (there are **no default
credentials**), and the first library scan starts automatically.

The stock compose file mounts the bundled sample library (original stories
with synthetic narration) so you can try the reader, player, pairing, and
exact two-way switching immediately.

## Volumes

| Mount                 | Purpose                                            | Notes                                                                                                                       |
| --------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `/data`               | SQLite database, derived reading indexes, progress | **Local disk only.** Never place it on SMB/NFS - SQLite in WAL mode is unsafe on network filesystems.                       |
| `/cache`              | Covers and alignment working files                 | Safe to delete; rebuilt on demand.                                                                                          |
| `/models`             | The alignment model                                | Holds the 317 MB aligner (`mms-fa/`) once downloaded. One model, every language.                                            |
| `/library/ebooks`     | Your ebook library                                 | `:ro` - read-only, required posture.                                                                                        |
| `/library/audiobooks` | Your audiobook library                             | `:ro`                                                                                                                       |
| `/library/alignments` | Finished alignments, one `.rpalign` file per pair  | **Read-write**, on purpose - never `:ro`. The only folder ReadPort writes into, and the one worth keeping across a rebuild. |

Which host folder lands on each of the three `/library` mounts is set in
`.env` - `RP_EBOOK_PATH`, `RP_AUDIOBOOK_PATH` and `RP_ALIGNMENT_PATH` - so the
compose file stays as shipped. The `/data`, `/cache` and `/models` mounts are
named Docker volumes (`rp-data`, `rp-cache`, `rp-models`) rather than bind
mounts, because SQLite wants a real local filesystem and because a named
volume cannot be pointed at a share by accident.

Your libraries can be the folders already used by Calibre / Calibre-Web
Automated (`.../Calibre Library`), Kavita, Audiobookshelf
(`Author/Title/*.m4b|mp3`), Shelfmark output, or any plain folder tree.
ReadPort detects `.epub` files and `.m4b/.mp3/.m4a/.flac/.ogg/.opus` audio
(one directory per multi-file book).

The alignment folder is one you make yourself, anywhere you like - beside the
books, or on the same share. It is the one library mount without `:ro`, and it
has to be writable by the container user: the entrypoint takes ownership of `/data`,
`/cache` and `/models` and deliberately never touches anything under
`/library`, so `chown` it to your `PUID`/`PGID` on the host. Leave
`RP_ALIGNMENT_DIRS` unset and alignments are kept in `<data>/alignments`
instead. In the image that is `/data/alignments`, persisted by the `rp-data`
named volume in Compose. It survives container replacement and image rebuilds;
only deleting/replacing that volume loses it. Back up the volume, and avoid
`docker compose down -v` for upgrades. Files saved there during an external
mount outage are still recognised after the mount recovers.

## Turning on alignment

Linking editions works out of the box. Computing the timings that make the
sentence-exact switch possible needs one thing: the alignment model.

Settings → Alignment downloads 317 MB into `/models/mms-fa/`. There is one
model and it covers every language, because it works on a romanized character
stream rather than on words - narration in Cyrillic costs it no more than
narration in English. Its licence is **CC-BY-NC-4.0 - non-commercial**, shown on the
card before the download starts; it is the only non-permissive component in
the project, so do not install it if you are running ReadPort commercially.

The same download from the command line, for a server with no browser pointed
at it:

```bash
docker compose exec readport readport-model install
docker compose exec readport readport-model status
```

Or copy `model_int8.onnx`, `vocab.json` and `config.json` into
`/models/mms-fa/` yourself; the server checks the files, not how they arrived.
An alignment that was waiting for the model starts on its own once they land.

Nothing else has to be switched on. A book's language is settled by the pair's
own override, then the EPUB's `dc:language`, then the audio tags, then the
ebook's own text; only when none of those says anything does
`RP_DEFAULT_LANGUAGE` decide. No model and no clip of the narration is
involved in that question.

`POST /api/preflight` (and the setup wizard, which calls it) answers "can
this container actually align a book?" in plain language: ffmpeg/ffprobe, the
native ONNX runtime, the model, free disk, the writable state volumes, the
library folders and whether the alignment folder will really take a file, each
with a concrete detail and a fix.

Then start a pair from the Pairing page. At the default `standard` precision,
which listens to about 7% of the narration and interpolates between the
matches, a six-hour audiobook takes roughly six minutes on the six-CPU
container these figures were measured on (`RP_ALIGN_THREADS=4`). The Pairing
page states what this server will take for that particular book, from the
speed it measured on the books before it. Full detail, including what the
aligner refuses and why, is in [alignment.md](alignment.md).

## Keeping alignments across a rebuild

Aligning is the only expensive thing this server ever does, and a container is
a disposable thing. So a finished alignment is not only a row in the database:
it is also written into the alignment folder as one self-contained file,
`<author> - <title> [<key>].rpalign` - gzipped JSON, readable with
`gunzip -c` if you ever want to see what you are keeping.

Those files find their way back to books by fingerprint, never by path,
filename or database id, none of which survive a reinstall. One fingerprint is
taken from the ebook's sentence ids, the other from the audiobook's per-track
durations, which is why retagging an audiobook - fixing the narrator,
embedding cover art, renaming chapters - costs you nothing: it moves no
narration and changes no duration. Re-encoding the audio, or swapping in a
different EPUB of the same title, does change them, and should: the timings
would no longer be about that file.

In practice, mount the same folder onto the new container and the pairing scan
that follows the first library scan takes back everything it recognises,
before it queues any alignment work of its own. A pair that already has an
alignment here is left alone, so a redeploy that kept its database imports
nothing; a file is applied whole or not at all, because a half-applied
alignment would leave the reader with silent holes and a coverage figure that
lied about them; files whose book is not in this library are passed over
without comment, and a file that _nearly_ matches - the ebook is here but the
audiobook's tracks differ - is explained in the server log. A pair you linked
by hand on the old install comes back too, pair and all: the file proves the
two books belong together.

Three things about the folder itself. Only files directly inside it are read

- sort them into subfolders by author and nothing will be imported. The folder
  may be reached through a symbolic link (a bare-metal install pointing
  `/data/alignments` at a NAS mount is fine), but a link planted _inside_ the
  folder is skipped whatever it points at. And if the folder is a NAS mount on
  the host, mount it before `docker compose up`: a bind mount of a path that is
  not mounted yet is a bind mount of the empty directory underneath, and files
  written there are on the host's local disk, invisible once the NAS appears.

Settings → Libraries → Alignment folder has the two manual buttons - **Save
all alignments to this folder**, for an install that has been aligning books
since before it had anywhere to put them, and **Import what is already
there**, for a folder you have just mounted and do not want to wait a scan
for. It also reports how many files are saved and how much space they take,
and says so plainly when the folder cannot be written to. In that case
alignments are kept in `<data>/alignments` instead: the work is never lost
over a bad mount, it is only not portable until you fix it. With the stock
Compose file that fallback lives in the `rp-data` named volume, which survives
container replacement and image upgrades; only deleting the volume
(`docker compose down -v`) discards it.

## Users, PUID/PGID, timezone

The container starts as root only to align its user with `PUID`/`PGID`
(default `1000:1000`) and own its writable volumes, then drops privileges
with `gosu`. Set them to the host user that owns your data volume. `TZ`
sets the container timezone. No Docker socket is mounted, no privileged mode
is used, and `no-new-privileges` is enabled in the compose file.

## Which image you get

The compose file builds from source, which works on any architecture and is
the default.

Images are also published to `ghcr.io/ilankushnir/readport` by CI, but for
**linux/amd64 only**. On an arm64 host (a Pi, an Apple Silicon VM, an ARM VPS)
keep `build: .`. On amd64 you may replace that line with an explicit version:

```yaml
image: ghcr.io/ilankushnir/readport:0.12.0
```

Tags: the release version (`0.12.0`), `latest` on tagged releases, `main` and
a short commit sha for every push to `main`. Pin the version rather than
following `latest`, so upgrading is something you decide to do; the release
notes in [CHANGELOG.md](../CHANGELOG.md) say what changed.

## Reverse proxy and HTTPS (required for the PWA)

Installable PWAs and service workers require HTTPS (or `localhost`). Put any
TLS-terminating proxy in front and set **both**:

- `RP_TRUST_HTTPS=1` so session cookies are marked `Secure`;
- `RP_TRUST_PROXY` to your proxy's address or CIDR (or `1` when the proxy is
  the only thing that can reach the port).

The second one matters more than it looks. Without it every request appears to
come from the proxy, so the per-address limit on failed sign-ins becomes a
single server-wide bucket - and a stranger guessing at one account can lock
everybody out. With it set, `X-Forwarded-For` is honoured only from the
addresses you name, so a client hitting the port directly still cannot forge
one.

Caddy example:

```
books.example.com {
    reverse_proxy readport:8383
}
```

nginx: proxy `/` to `readport:8383` with `proxy_set_header Host $host;`
and websocket defaults are not needed (no websockets). Body size defaults are
fine - clients never upload media.

After that, iPhone Safari → Share → **Add to Home Screen** gives a
standalone, offline-capable app.

### Behind Authentik / Authelia / oauth2-proxy (single sign-on)

If your proxy already authenticates users, let ReadPort trust it instead of
showing a second login (details and the threat model in docs/security.md):

```yaml
# Traefik: the authentik forward-auth middleware must forward the username
# header (authResponseHeaders: [X-authentik-username, …]).
environment:
  RP_TRUST_PROXY: 192.168.1.50 # the proxy's address(es)
  RP_TRUST_HTTPS: '1'
  RP_PROXY_AUTH_HEADER: x-authentik-username
  RP_PROXY_AUTH_SOURCES: 192.168.1.50/32 # header trusted only from this TCP peer
  RP_PROXY_AUTH_ADMINS: ilan # optional; first user is admin anyway
```

The direct LAN port keeps the normal password login (a header sent straight to
the port is ignored because the peer is not the proxy). An account the proxy
provisioned starts with no password of its own; Settings → Account offers to
add one, which is the break-glass path when the provider is down.

**Opening the library to people who are not in your identity provider.** An
invitation cannot get past a proxy that authenticates every request - the
invitee reaches the provider's login page, not ReadPort's. To use invitations,
take ReadPort's route out of the forward-auth middleware **and remove
`RP_PROXY_AUTH_HEADER` / `RP_PROXY_AUTH_SOURCES` in the same change**: without
the middleware the proxy no longer overwrites that header, so anything a
client sends arrives with the proxy as its TCP peer and would be believed.
Give your own account a password before you do either, or you will have no way
to sign in.

## Resource and concurrency controls

- `RP_JOB_CONCURRENCY` (default 2) bounds simultaneous alignments; scans,
  indexing, pairing and model downloads run in their own lanes beside them.
  A job interrupted by a container restart is re-queued, not failed.
- The compose file sets container memory limits; adjust to taste.
- **Aligning a book is the only heavy compute here, and it is CPU-bound.**
  At the default `standard` precision a six-hour audiobook takes about six
  minutes on a six-CPU container. `exact` listens to every second of the
  narration instead of sampling it, for sentence-perfect timings at roughly
  fifteen times the cost; it is a per-server choice under Settings →
  Alignment, not a per-book one.
- `RP_ALIGN_THREADS` (default 4) caps the threads the model may use. Past the
  container's CPU allowance it gets slower rather than faster, so set it to
  that allowance and not to the host's core count - and remember that it
  multiplies with `RP_JOB_CONCURRENCY`, since each alignment asks for that many
  threads of its own.
- Nothing heavy runs until a pair is actually aligned: an idle instance
  scanning and serving books is cheap.
- For big libraries, run the dedicated worker:
  `docker compose --profile worker up -d` with `RP_INLINE_WORKER=0` on the
  web service. Both share `/data` (same host volume) safely.

## Backup and restore

Everything ReadPort owns is in the `/data` volume (the `/cache` and
`/models` volumes are reproducible).

```bash
# Backup (container can stay up; SQLite is WAL with a single writer host)
docker compose stop readport   # optional but recommended for a clean copy
docker run --rm -v readport_rp-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/readport-data-$(date +%F).tar.gz -C /data .
docker compose start readport

# Restore
docker compose down
docker run --rm -v readport_rp-data:/data -v "$PWD":/backup alpine \
  sh -c "rm -rf /data/* && tar xzf /backup/readport-data-YYYY-MM-DD.tar.gz -C /data"
docker compose up -d
```

Your book folders are read-only sources and are not part of ReadPort backups.
The alignment folder is not either, and does not need to be: it is already the
portable copy, and either it or a restored `/data` brings the timings back on
its own. Back it up with the rest of your library only if you would rather not
recompute anything after losing both.

## Upgrades and migrations

```bash
git pull            # or, on the published image: bump the tag in compose and
                    #   docker compose pull
docker compose up -d --build
```

Database schema migrations run automatically at startup (append-only,
recorded in `schema_migrations`). Downgrades are not supported - restore the
`/data` backup taken before upgrading instead.

## Troubleshooting

| Symptom                                                   | Likely cause / fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Library is empty after setup                              | Check the `:ro` mounts exist inside the container (`docker compose exec readport ls /library/ebooks`) and rescan from Settings.                                                                                                                                                                                                                                                                                                                                                                                                   |
| Books stuck in "Indexing…"                                | See Settings → Background activity for the job error; `docker compose logs readport`.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Nothing ever starts aligning                              | The model is not downloaded (Settings → Alignment), or unattended alignment is off (Settings → Alignment → _Align new matches automatically_), or the metadata match was not confident enough to run without being asked - confirm it on the Pairing page and it aligns immediately.                                                                                                                                                                                                                                              |
| Alignment fails with "model is not installed"             | Download the alignment model in Settings → Alignment, or run `readport-model install`; the Pairing page turns the error into a one-click download and re-queues the alignment when the files land.                                                                                                                                                                                                                                                                                                                                |
| Pairing says the narration is not the same work           | The aligner found almost no matching passages. That usually means an abridged, dramatized or differently translated edition - a correct pair produces hundreds of anchors per thousand characters. Confirm the pair manually only if you are sure.                                                                                                                                                                                                                                                                                |
| Nothing appears in the alignment folder                   | The mount is `:ro`, or the host folder is not writable by `PUID`/`PGID`. Settings → Libraries → Alignment folder says which, and the alignments are safe in `<data>/alignments` meanwhile - fix the mount and press _Save all alignments to this folder_.                                                                                                                                                                                                                                                                         |
| A rebuilt install did not take its alignments back        | The saved files no longer describe these files: a re-encoded audiobook (different track durations) or a different EPUB of the same title (different sentence ids) is a different pair, and its timings would be wrong. Aligning again is the only honest fix. The server log names near misses ("the ebook is here, but no audiobook has its 12 tracks"). Files in subfolders are not read; a Node/ICU upgrade that changes sentence segmentation also changes the text fingerprint, which a re-index of that book makes visible. |
| A book shows "Indexing failed"                            | The EPUB may be malformed or DRM-protected. ReadPort does not remove DRM.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| "Add to Home Screen" gives a browser shortcut, not an app | You are not on HTTPS. See the reverse-proxy section.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| m4b won't play in Firefox/Chromium                        | AAC decoding is missing from some open-source browser builds. Chrome, Edge and Safari play m4b/m4a; mp3/flac/ogg play everywhere.                                                                                                                                                                                                                                                                                                                                                                                                 |
| Progress didn't sync from my phone                        | It is queued locally (IndexedDB) and reconciles on the next reachable sync; nothing is lost.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Login says "Too many attempts"                            | Login throttle: 10 tries per account from one IP, 30 from that IP across all accounts, both over 5 minutes. Wait a few minutes.                                                                                                                                                                                                                                                                                                                                                                                                   |
| Reset the admin password                                  | Stop the stack, delete the `users`/`sessions` rows: `docker compose run --rm readport node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/readport.db');d.exec('DELETE FROM sessions; DELETE FROM users;')"` - the next visit shows first-run setup again. Reading progress and pair decisions are preserved.                                                                                                                                                                                    |
