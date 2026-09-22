import { useState } from 'react';
import { APP_KINDS, type AppKind, type AppLink } from '@readport/shared';
import { api, failureMessage } from '../api/client';
import { APP_PRESETS, appMark, forgetAppLinks } from '../components/AppLinks';
import { IconTrash } from '../components/icons';
import { useToast } from '../components/ui';
import { useT } from '../i18n';

const HUE: Record<AppKind, string> = {
  cwa: 'var(--rd-mark-sky)',
  abs: 'var(--rd-mark-plum)',
  shelfmark: 'var(--rd-mark-amber)',
  readmeabook: 'var(--rd-mark-rose)',
  kavita: 'var(--rd-mark-sand)',
  custom: 'var(--rp-text-soft)',
};

const newId = () => `app_${Math.random().toString(36).slice(2, 10)}`;

/**
 * Settings → Connected apps. Admin only.
 *
 * Saves on its own button rather than through the page's draft, the way the
 * alignment toggles do: the list is edited as a unit, and the tiles in the
 * shelves should change the moment it is saved, not when some unrelated
 * setting is.
 */
export function ConnectedAppsSection({ initial }: { initial: AppLink[] }) {
  const t = useT();
  const toast = useToast();
  const [apps, setApps] = useState<AppLink[]>(initial ?? []);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const update = (next: AppLink[]) => {
    setApps(next);
    setDirty(true);
  };
  const patch = (id: string, change: Partial<AppLink>) =>
    update(apps.map((a) => (a.id === id ? { ...a, ...change } : a)));
  const add = () =>
    update([...apps, { id: newId(), kind: 'cwa', name: APP_PRESETS.cwa.name, url: '' }]);
  const remove = (id: string) => update(apps.filter((a) => a.id !== id));

  const setKind = (id: string, kind: AppKind) => {
    const current = apps.find((a) => a.id === id);
    // A preset names itself; a custom app keeps whatever was typed.
    const name =
      kind === 'custom'
        ? current && current.kind !== 'custom'
          ? ''
          : (current?.name ?? '')
        : APP_PRESETS[kind].name;
    patch(id, { kind, name });
  };

  const invalid = apps.filter((a) => !/^https?:\/\/\S+$/i.test(a.url.trim()) || !a.name.trim());

  const save = async () => {
    if (invalid.length) {
      toast.show(t('settings.apps.invalidUrl'));
      return;
    }
    setSaving(true);
    try {
      await api('/api/settings', {
        method: 'PUT',
        body: { apps: apps.map((a) => ({ ...a, url: a.url.trim(), name: a.name.trim() })) },
      });
      forgetAppLinks();
      setDirty(false);
      toast.show(t('settings.apps.saved'));
    } catch (err) {
      toast.show(failureMessage(err, t('settings.couldNotSave'), t));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="settings-section" aria-label={t('settings.apps.title')} id="apps">
      <h2>{t('settings.apps.title')}</h2>
      <p className="settings-section__lede">{t('settings.apps.lede')}</p>

      {apps.length === 0 ? (
        <p className="hint">{t('settings.apps.empty')}</p>
      ) : (
        <div className="apps-editor">
          {apps.map((app) => (
            <div className="apps-editor__row" key={app.id}>
              <span
                className="apps__mark"
                style={{ '--apps-hue': HUE[app.kind] } as React.CSSProperties}
                aria-hidden="true"
              >
                {appMark(app)}
              </span>
              <label className="visually-hidden" htmlFor={`app-kind-${app.id}`}>
                {t('settings.apps.kind')}
              </label>
              <select
                id={`app-kind-${app.id}`}
                className="input input--select"
                value={app.kind}
                onChange={(e) => setKind(app.id, e.target.value as AppKind)}
              >
                {APP_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k === 'custom' ? t('settings.apps.custom') : APP_PRESETS[k].name}
                  </option>
                ))}
              </select>
              {app.kind === 'custom' ? (
                <>
                  <label className="visually-hidden" htmlFor={`app-name-${app.id}`}>
                    {t('settings.apps.name')}
                  </label>
                  <input
                    id={`app-name-${app.id}`}
                    className="input"
                    placeholder={t('settings.apps.name')}
                    value={app.name}
                    maxLength={40}
                    onChange={(e) => patch(app.id, { name: e.target.value })}
                  />
                </>
              ) : null}
              <label className="visually-hidden" htmlFor={`app-url-${app.id}`}>
                {t('settings.apps.url')}
              </label>
              <input
                id={`app-url-${app.id}`}
                className="input input--url"
                inputMode="url"
                dir="ltr"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder={t('settings.apps.urlPlaceholder')}
                value={app.url}
                onChange={(e) => patch(app.id, { url: e.target.value })}
                style={app.kind === 'custom' ? { gridColumn: '2 / -2' } : undefined}
              />
              <button
                className="icon-btn"
                onClick={() => remove(app.id)}
                aria-label={t('settings.apps.remove', { name: app.name || app.url })}
              >
                <IconTrash size={16} />
              </button>
              <label className="apps-editor__smart">
                <input type="checkbox" role="switch" disabled checked={false} readOnly />
                <span>
                  {t('settings.apps.smart')}
                  <span className="hint" style={{ display: 'block' }}>
                    {t('settings.apps.smartHint')}
                  </span>
                </span>
                <span className="apps-editor__soon">{t('settings.apps.soon')}</span>
              </label>
            </div>
          ))}
        </div>
      )}

      <div className="settings-actions" style={{ display: 'flex', gap: 'var(--sp-2)' }}>
        <button className="btn btn--ghost" onClick={add} disabled={apps.length >= 12}>
          {t('settings.apps.add')}
        </button>
        <button
          className="btn btn--primary"
          onClick={() => void save()}
          disabled={saving || !dirty}
        >
          {t('common.save')}
        </button>
      </div>
    </section>
  );
}
