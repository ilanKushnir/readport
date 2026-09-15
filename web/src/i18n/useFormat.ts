import { useMemo } from 'react';
import { useI18n } from './index';
import { formatDuration } from '../lib/format';
import { languageListName, languageName } from '../lib/languageName';

/**
 * Numbers, dates, spans and names, the way the current interface language
 * writes them. Everything here goes through Intl with the app's locale, not
 * the browser's - a reader who chose Hebrew for the interface gets Hebrew
 * digits and dates whatever their browser is set to.
 *
 * Durations as m:ss stay ASCII digits everywhere: a timestamp on a scrubber
 * is a number to be read at a glance, and every locale reads those.
 */
export function useFormat() {
  const { tag, t } = useI18n();
  return useMemo(() => {
    const safe = <T>(make: () => T, fallback: () => T): T => {
      try {
        return make();
      } catch {
        return fallback();
      }
    };
    const numberFmt = safe(
      () => new Intl.NumberFormat(tag),
      () => new Intl.NumberFormat('en'),
    );
    const percentFmt = safe(
      () => new Intl.NumberFormat(tag, { style: 'percent', maximumFractionDigits: 0 }),
      () => new Intl.NumberFormat('en', { style: 'percent', maximumFractionDigits: 0 }),
    );
    const dateFmt = safe(
      () => new Intl.DateTimeFormat(tag, { dateStyle: 'medium' }),
      () => new Intl.DateTimeFormat('en', { dateStyle: 'medium' }),
    );
    const dateTimeFmt = safe(
      () => new Intl.DateTimeFormat(tag, { dateStyle: 'medium', timeStyle: 'short' }),
      () => new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }),
    );
    const relative = safe(
      () => new Intl.RelativeTimeFormat(tag, { numeric: 'auto' }),
      () => new Intl.RelativeTimeFormat('en', { numeric: 'auto' }),
    );
    const unit = (u: string) =>
      safe(
        () =>
          new Intl.NumberFormat(tag, {
            style: 'unit',
            unit: u,
            unitDisplay: 'short',
            maximumFractionDigits: 1,
          }),
        () => new Intl.NumberFormat('en', { maximumFractionDigits: 1 }),
      );
    const byteFmt = unit('byte');
    const kbFmt = unit('kilobyte');
    const mbFmt = unit('megabyte');
    const gbFmt = unit('gigabyte');

    return {
      number: (n: number) => numberFmt.format(n),
      percent: (pct: number) => percentFmt.format(Math.min(1, Math.max(0, pct))),
      date: (iso: string) => {
        const d = new Date(iso);
        return Number.isNaN(d.getTime()) ? iso : dateFmt.format(d);
      },
      dateTime: (iso: string) => {
        const d = new Date(iso);
        return Number.isNaN(d.getTime()) ? iso : dateTimeFmt.format(d);
      },
      duration: formatDuration,
      bytes: (bytes: number | null | undefined) => {
        if (bytes == null || !Number.isFinite(bytes)) return '–';
        if (bytes < 1024) return byteFmt.format(bytes);
        const kb = bytes / 1024;
        if (kb < 1024) return kbFmt.format(kb);
        const mb = kb / 1024;
        if (mb < 1024) return mbFmt.format(mb);
        return gbFmt.format(mb / 1024);
      },
      /** A rough span in words for a time estimate: "about 3 h". */
      span: (ms: number | null | undefined) => {
        if (ms == null || !Number.isFinite(ms) || ms <= 0) return t('format.unknownSpan');
        const mins = ms / 60_000;
        if (mins < 1) return t('format.underMinute');
        if (mins < 90) return t('format.aboutMinutes', { n: Math.round(mins) });
        const hours = mins / 60;
        if (hours < 36) return t('format.aboutHours', { n: Math.round(hours) });
        const days = hours / 24;
        return t('format.aboutDays', {
          n: days < 10 ? Math.round(days * 10) / 10 : Math.round(days),
        });
      },
      /** "3 minutes ago", "yesterday", or a date once the distance stops being useful. */
      ago: (iso: string | null | undefined, whenNever: string = t('format.never')) => {
        if (!iso) return whenNever;
        const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
        if (!Number.isFinite(s)) return whenNever;
        if (s < 90) return t('format.justNow');
        if (s < 3600) return relative.format(-Math.round(s / 60), 'minute');
        if (s < 86_400) return relative.format(-Math.round(s / 3600), 'hour');
        if (s < 86_400 * 14) return relative.format(-Math.round(s / 86_400), 'day');
        const d = new Date(iso);
        return Number.isNaN(d.getTime()) ? whenNever : dateFmt.format(d);
      },
      ordinal: (n: number) => t('format.ordinal', { n }),
      languageName: (code: string | null | undefined) => languageName(code, tag),
      languageListName: (value: string) => languageListName(value, tag),
      list: (items: string[]) =>
        safe(
          () => new Intl.ListFormat(tag, { style: 'long', type: 'conjunction' }).format(items),
          () => items.join(', '),
        ),
    };
  }, [tag, t]);
}
