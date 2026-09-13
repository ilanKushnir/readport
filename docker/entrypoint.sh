#!/bin/sh
# Align the runtime user with the host's PUID/PGID (default 1000:1000), give
# it the writable volumes, then drop privileges. Library mounts stay
# read-only and untouched.
set -e

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

# Take ownership of one volume ReadPort writes to. Only ReadPort's own files,
# never a library mount, and never following a symlink out of the volume.
# A read-only mount fails every chown here, which is why nothing is fatal:
# the server's preflight reports what it still cannot write.
claim() {
  [ -d "$1" ] || return 0
  chown -h "$PUID:$PGID" "$1" 2>/dev/null || true
  find "$1" -maxdepth 2 ! -type l ! -user "$PUID" -exec chown -h "$PUID:$PGID" {} + 2>/dev/null || true
}

if [ "$(id -u)" = "0" ]; then
  CURRENT_GID="$(getent group readport | cut -d: -f3)"
  CURRENT_UID="$(getent passwd readport | cut -d: -f3)"
  # -o allows a PUID/PGID that collides with an existing system UID/GID.
  if [ "$CURRENT_GID" != "$PGID" ]; then
    groupmod -o -g "$PGID" readport
  fi
  if [ "$CURRENT_UID" != "$PUID" ] || [ "$CURRENT_GID" != "$PGID" ]; then
    usermod -o -u "$PUID" -g "$PGID" readport
  fi
  for d in "${RP_DATA_DIR:-/data}" "${RP_CACHE_DIR:-/cache}" "${RP_MODELS_DIR:-/models}"; do
    claim "$d"
  done
  # Alignment folders are the fourth writable volume and the one people mount
  # by hand, so they arrive root-owned from `mkdir` on the host and every save
  # fails. Same comma-separated spelling the server parses.
  if [ -n "${RP_ALIGNMENT_DIRS:-}" ]; then
    # The trailing newline matters: `read` discards a final unterminated
    # line, which would silently skip the last folder in the list.
    printf '%s\n' "$RP_ALIGNMENT_DIRS" | tr ',' '\n' | while IFS= read -r d; do
      claim "$(printf '%s' "$d" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    done
  fi
  exec gosu "$PUID:$PGID" "$@"
fi

exec "$@"
