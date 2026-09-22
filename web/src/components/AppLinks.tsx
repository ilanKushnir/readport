import { useEffect, useState } from 'react';
import type { AppKind, AppLink } from '@readport/shared';
import { api } from '../api/client';
import { useT } from '../i18n';
import './apps.css';

/**
 * The presets an admin can pick from, with the two-letter mark each tile
 * wears. Favicons would be the obvious tile, and the content security policy
 * forbids them on purpose (`img-src 'self'`): a reader's browser must not
 * fetch from every address an admin typed. A monogram in a fixed hue is
 * recognisable at a glance and costs nothing.
 */
export const APP_PRESETS: Record<
  Exclude<AppKind, 'custom'>,
  { name: string; mark: string; short: string }
> = {
  cwa: { name: 'Calibre-Web Automated', mark: 'CW', short: 'Calibre-Web' },
  abs: { name: 'Audiobookshelf', mark: 'AB', short: 'Audiobookshelf' },
  shelfmark: { name: 'Shelfmark', mark: 'SM', short: 'Shelfmark' },
  readmeabook: { name: 'ReadMeABook', mark: 'RM', short: 'ReadMeABook' },
  kavita: { name: 'Kavita', mark: 'KV', short: 'Kavita' },
};

/** The name under a tile: the preset's short form, or whatever the admin typed. */
function tileName(app: AppLink): string {
  return app.kind === 'custom' ? app.name : APP_PRESETS[app.kind].short;
}

/** Hues from the app's own highlight palette, one per kind; custom cycles. */
const HUE: Record<AppKind, string> = {
  cwa: 'var(--rd-mark-sky)',
  abs: 'var(--rd-mark-plum)',
  shelfmark: 'var(--rd-mark-amber)',
  readmeabook: 'var(--rd-mark-rose)',
  kavita: 'var(--rd-mark-sand)',
  custom: 'var(--rp-text-soft)',
};

export function appMark(app: AppLink): string {
  if (app.kind !== 'custom') return APP_PRESETS[app.kind].mark;
  const words = app.name.trim().split(/\s+/).filter(Boolean);
  const mark =
    words.length >= 2 ? words[0]![0]! + words[1]![0]! : app.name.trim().slice(0, 2) || '?';
  return mark.toUpperCase();
}

let cache: AppLink[] | null = null;

/** The apps beside this library, fetched once per page load. */
export function useAppLinks(): AppLink[] {
  const [apps, setApps] = useState<AppLink[]>(cache ?? []);
  useEffect(() => {
    if (cache) return;
    let live = true;
    api<{ apps: AppLink[] }>('/api/apps')
      .then((r) => {
        const list = Array.isArray(r?.apps) ? r.apps : [];
        cache = list;
        if (live) setApps(list);
      })
      .catch(() => {
        /* offline, or an older server: no tiles, and nothing else changes */
      });
    return () => {
      live = false;
    };
  }, []);
  return apps;
}

/** Drop the cached list, after the admin has changed it. */
export function forgetAppLinks(): void {
  cache = null;
}

/**
 * A row of tiles at the foot of the shelves: the other apps in this
 * household, one tap away. Rendered nowhere when there are none - an empty
 * "Apps" heading would be a promise the admin has not made.
 */
export function AppLinks() {
  const t = useT();
  const apps = useAppLinks();
  if (apps.length === 0) return null;
  return (
    <section className="apps" aria-label={t('shell.apps.heading')}>
      <h2 className="sidebar__heading">{t('shell.apps.heading')}</h2>
      <ul className="apps__row">
        {apps.map((app) => (
          <li key={app.id}>
            <a
              className="apps__tile"
              href={app.url}
              target="_blank"
              rel="noopener noreferrer"
              title={t('shell.apps.open', { name: app.name })}
            >
              <span
                className="apps__mark"
                style={{ '--apps-hue': HUE[app.kind] } as React.CSSProperties}
                aria-hidden="true"
              >
                {appMark(app)}
              </span>
              <span className="apps__name">{tileName(app)}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
