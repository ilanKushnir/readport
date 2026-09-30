import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { IconChevronRight } from '../components/icons';
import { useT } from '../i18n';
import { useFormat } from '../i18n/useFormat';
import { inLastDays, isStatsResponse, streak, summarise, type StatsResponse } from './insights';
import './stats.css';

/**
 * The figures last shown, so coming back to the library draws the strip at
 * once instead of a moment later - when it would push the grid down under
 * a reader who has just been put back where they were.
 */
let lastShown: StatsResponse | null = null;

/**
 * One line on the library home: this week so far, and the way to the rest.
 *
 * Rendered only once there is something to say. A reader who has never
 * opened a book does not need to be told their stats are empty; the page
 * they would land on already says so, kindly.
 */
export function StatsStrip() {
  const t = useT();
  const f = useFormat();
  const [data, setData] = useState<StatsResponse | null>(lastShown);
  useEffect(() => {
    let live = true;
    api<unknown>('/api/stats?days=14')
      .then((d) => {
        if (!isStatsResponse(d)) return;
        lastShown = d;
        if (live) setData(d);
      })
      .catch(() => {
        /* older server, or offline: no strip */
      });
    return () => {
      live = false;
    };
  }, []);
  if (!data || data.sessions.length === 0) return null;
  const now = new Date();
  const week = summarise(inLastDays(data.sessions, 7, now), data.books);
  const st = streak(data.sessions, now);
  return (
    <Link to="/stats" className="stats-strip">
      <span className="stats-strip__label">{t('stats.strip.title')}</span>
      <span className="stats-strip__figures">
        <span>{f.duration(week.seconds * 1000)}</span>
        <span>
          {t('stats.figure.sittings').toLowerCase()} {f.number(week.sittings)}
        </span>
        {st.current > 0 && (
          <span>
            {t('stats.figure.streak').toLowerCase()}{' '}
            {t('stats.figure.streakDays', { n: st.current })}
          </span>
        )}
      </span>
      <span className="stats-strip__go">
        {t('stats.strip.open')} <IconChevronRight size={15} data-mirror="" />
      </span>
    </Link>
  );
}
