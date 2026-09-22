import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { EmptyState } from '../components/ui';
import { IconBookOpen, IconHeadphones } from '../components/icons';
import { useI18n, useT } from '../i18n';
import { useFormat } from '../i18n/useFormat';
import {
  bestWindow,
  bookInsights,
  dailyTotals,
  heatmap,
  hourBuckets,
  inLastDays,
  isStatsResponse,
  readiness,
  type StatsResponse,
  streak,
  summarise,
} from '../stats/insights';
import '../stats/stats.css';

const WINDOW_DAYS = 90;

/**
 * The reading stats page.
 *
 * Description first, one suggestion last. Most of this page says what
 * happened - when, how long, how far - and only one section presumes to
 * advise, and only once it has two weeks of evidence. The heatmap is the
 * one graphic that carries the page; the rest is set as sentences and
 * figures, because a reader's habits are a thing to be read, not
 * dashboarded.
 */
export function StatsPage() {
  const t = useT();
  const { tag } = useI18n();
  const f = useFormat();
  const [data, setData] = useState<StatsResponse | null>(null);
  const [error, setError] = useState<'network' | 'older' | null>(null);

  useEffect(() => {
    let live = true;
    api<unknown>(`/api/stats?days=${WINDOW_DAYS}`)
      .then((d) => {
        if (!live) return;
        if (isStatsResponse(d)) setData(d);
        else setError('older');
      })
      .catch((err) => {
        if (!live) return;
        setError(err instanceof ApiError && err.status === 404 ? 'older' : 'network');
      });
    return () => {
      live = false;
    };
  }, []);

  const now = useMemo(() => new Date(), []);
  const model = useMemo(() => {
    if (!data) return null;
    const week = inLastDays(data.sessions, 7, now);
    const weekSummary = summarise(week, data.books);
    const all = summarise(data.sessions, data.books);
    const buckets = hourBuckets(data.sessions);
    const grid = heatmap(data.sessions);
    const weekdaySeconds = grid
      .slice(0, 5)
      .flat()
      .reduce((a, b) => a + b, 0);
    const weekendSeconds = grid
      .slice(5)
      .flat()
      .reduce((a, b) => a + b, 0);
    const from = new Date(now);
    from.setDate(from.getDate() - 55);
    return {
      week: weekSummary,
      all,
      streak: streak(data.sessions, now),
      grid,
      max: Math.max(1, ...grid.flat()),
      buckets,
      best: bestWindow(buckets),
      ready: readiness(data.sessions),
      weekdayPct: Math.round((100 * weekdaySeconds) / Math.max(1, weekdaySeconds + weekendSeconds)),
      weekendPct: Math.round((100 * weekendSeconds) / Math.max(1, weekdaySeconds + weekendSeconds)),
      books: bookInsights(data),
      daily: dailyTotals(data.sessions, from, now),
    };
  }, [data, now]);

  const hourLabel = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(tag, { hour: 'numeric' });
    return (h: number) => fmt.format(new Date(2000, 0, 1, h % 24));
  }, [tag]);
  const weekdayLabel = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(tag, { weekday: 'short' });
    // 2024-01-01 is a Monday.
    return (i: number) => fmt.format(new Date(2024, 0, 1 + i));
  }, [tag]);

  if (error) {
    return (
      <main className="app-main stats-page" id="main-content" tabIndex={-1}>
        <header className="page-head">
          <h1>{t('stats.title')}</h1>
        </header>
        <div className="banner banner--error" role="alert">
          {error === 'older' ? t('stats.olderServer') : t('stats.error')}
        </div>
      </main>
    );
  }

  if (!data || !model) {
    return (
      <main className="app-main stats-page" id="main-content" tabIndex={-1}>
        <header className="page-head">
          <h1>{t('stats.title')}</h1>
        </header>
        <div className="skeleton" style={{ height: 28, maxWidth: 420 }} />
        <div className="skeleton" style={{ height: 180, marginTop: 24 }} />
      </main>
    );
  }

  if (data.sessions.length === 0) {
    return (
      <main className="app-main stats-page" id="main-content" tabIndex={-1}>
        <header className="page-head">
          <h1>{t('stats.title')}</h1>
        </header>
        <EmptyState
          icon={<IconBookOpen size={28} />}
          title={t('stats.lead.empty')}
          action={
            <Link className="btn btn--primary" to="/">
              {t('stats.lead.openLibrary')}
            </Link>
          }
        >
          {t('stats.lead.emptyBody')}
        </EmptyState>
      </main>
    );
  }

  const { week, all, streak: st, grid, max, best, ready, books, daily } = model;
  const weeks = weeksOf(daily);
  const weekAvg = weeks.length ? weeks.reduce((a, w) => a + w.seconds, 0) / weeks.length : 0;

  return (
    <main className="app-main stats-page" id="main-content" tabIndex={-1}>
      <header className="page-head">
        <h1>{t('stats.title')}</h1>
      </header>

      {/* ---- the lead: one sentence, three quiet figures ---- */}
      <p className="stats-lead">
        {t('stats.lead.week', {
          seconds: week.seconds > 0 ? 'other' : 'zero',
          time: f.duration(week.seconds * 1000),
          sittings: week.sittings,
          days: week.activeDays,
        })}
      </p>
      <dl className="stats-figures">
        <div>
          <dt>{t('stats.figure.thisWeek')}</dt>
          <dd>{f.duration(week.seconds * 1000)}</dd>
        </div>
        <div>
          <dt>{t('stats.figure.sittings')}</dt>
          <dd>{f.number(week.sittings)}</dd>
        </div>
        <div>
          <dt>{t('stats.figure.streak')}</dt>
          <dd>
            {t('stats.figure.streakDays', { n: st.current })}
            <small>
              {st.current === 0
                ? t('stats.figure.streakNone')
                : st.today
                  ? t('stats.figure.streakToday')
                  : t('stats.figure.streakKeep')}
              {st.longest > st.current ? ` · ${t('stats.figure.longest', { n: st.longest })}` : ''}
            </small>
          </dd>
        </div>
      </dl>

      {/* ---- when you read: the heatmap ---- */}
      <section className="stats-section" aria-labelledby="stats-when">
        <h2 id="stats-when">{t('stats.when.title')}</h2>
        <p className="stats-section__lede">{t('stats.when.lede', { days: WINDOW_DAYS })}</p>
        <div className="heat" role="img" aria-label={t('stats.when.title')}>
          <div className="heat__hours" aria-hidden="true">
            <span />
            {[0, 6, 12, 18].map((h) => (
              <span key={h} style={{ gridColumn: h + 2 }}>
                {hourLabel(h)}
              </span>
            ))}
          </div>
          {grid.map((row, d) => (
            <div className="heat__row" key={d}>
              <span className="heat__day" aria-hidden="true">
                {weekdayLabel(d)}
              </span>
              {row.map((sec, h) => (
                <span
                  key={h}
                  className="heat__cell"
                  style={{ '--heat': sec / max } as React.CSSProperties}
                  title={t('stats.when.cell', {
                    day: weekdayLabel(d),
                    hour: hourLabel(h),
                    time: sec > 0 ? f.duration(sec * 1000) : '0',
                  })}
                />
              ))}
            </div>
          ))}
          <div className="heat__legend" aria-hidden="true">
            <span>{t('stats.when.less')}</span>
            {[0.1, 0.3, 0.55, 0.8, 1].map((v) => (
              <span key={v} className="heat__cell" style={{ '--heat': v } as React.CSSProperties} />
            ))}
            <span>{t('stats.when.more')}</span>
          </div>
        </div>
        <p className="stats-note">
          {t('stats.when.split', { weekdayPct: model.weekdayPct, weekendPct: model.weekendPct })}
        </p>
      </section>

      {/* ---- the one suggestion ---- */}
      <section className="stats-section stats-best" aria-labelledby="stats-best">
        <h2 id="stats-best">{t('stats.best.title')}</h2>
        {!ready.ready || !best ? (
          <p className="stats-section__lede">
            {ready.daysToGo > 0
              ? t('stats.best.collecting', { days: ready.daysToGo })
              : t('stats.best.collectingSittings')}
          </p>
        ) : (
          <BestTime
            best={best}
            allMeanSitting={all.meanSitting}
            totalSeconds={all.seconds}
            hourLabel={hourLabel}
          />
        )}
      </section>

      {/* ---- reading and listening ---- */}
      <section className="stats-section" aria-labelledby="stats-split">
        <h2 id="stats-split">{t('stats.split.title')}</h2>
        <div
          className="split"
          role="img"
          aria-label={`${t('stats.split.reading')} ${f.duration(all.readSeconds * 1000)}, ${t('stats.split.listening')} ${f.duration(all.listenSeconds * 1000)}`}
        >
          <span
            className="split__read"
            style={{ flexGrow: Math.max(all.readSeconds, all.seconds ? 0 : 1) }}
          />
          <span className="split__listen" style={{ flexGrow: all.listenSeconds }} />
        </div>
        <dl className="stats-figures stats-figures--small">
          <div>
            <dt>
              <IconBookOpen size={14} /> {t('stats.split.reading')}
            </dt>
            <dd>{f.duration(all.readSeconds * 1000)}</dd>
          </div>
          <div>
            <dt>
              <IconHeadphones size={14} /> {t('stats.split.listening')}
            </dt>
            <dd>{f.duration(all.listenSeconds * 1000)}</dd>
          </div>
          {all.words !== null && (
            <div>
              <dt>{t('stats.split.words', { n: all.words })}</dt>
              <dd>
                {all.wordsPerMinute !== null
                  ? t('stats.split.pace', { n: all.wordsPerMinute })
                  : ''}
              </dd>
            </div>
          )}
        </dl>
        <p className="stats-note">
          {t('stats.split.sitting', {
            time: f.duration(all.meanSitting * 1000),
            longest: f.duration(all.longestSitting * 1000),
          })}
        </p>
      </section>

      {/* ---- books ---- */}
      {books.length > 0 && (
        <section className="stats-section" aria-labelledby="stats-books">
          <h2 id="stats-books">{t('stats.books.title')}</h2>
          <p className="stats-section__lede">{t('stats.books.lede', { days: WINDOW_DAYS })}</p>
          <ul className="stats-books">
            {books.map(({ book, seconds, secondsToFinish, lastReadAt }) => (
              <li key={book.id}>
                <div className="stats-books__head">
                  {book.title ? (
                    <Link to={`/book/${book.id}`} className="stats-books__title">
                      {book.title}
                    </Link>
                  ) : (
                    <span className="stats-books__title stats-books__title--gone">
                      {t('stats.books.unknownTitle')}
                    </span>
                  )}
                  <span className="stats-books__pct">
                    {book.finished ? t('stats.books.finished') : f.percent(book.pct)}
                  </span>
                </div>
                <div
                  className="progressbar"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(book.pct * 100)}
                >
                  <span style={{ width: `${Math.min(100, book.pct * 100)}%` }} />
                </div>
                <p className="stats-books__meta">
                  {book.kind === 'audio' ? (
                    <IconHeadphones size={13} />
                  ) : (
                    <IconBookOpen size={13} />
                  )}
                  <span>{t('stats.books.timeIn', { time: f.duration(seconds * 1000) })}</span>
                  {book.finished && book.finishedAt ? (
                    <span>{t('stats.books.finishedOn', { date: f.date(book.finishedAt) })}</span>
                  ) : secondsToFinish !== null ? (
                    <span>
                      {t('stats.books.left', { time: f.duration(secondsToFinish * 1000) })}
                    </span>
                  ) : null}
                  <span>{t('stats.books.lastRead', { when: f.ago(lastReadAt) })}</span>
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ---- eight weeks ---- */}
      <section className="stats-section" aria-labelledby="stats-weeks">
        <h2 id="stats-weeks">{t('stats.weeks.title')}</h2>
        <div className="weeks" role="img" aria-label={t('stats.weeks.title')}>
          {weeks.map((w) => (
            <div
              className="weeks__col"
              key={w.start}
              title={t('stats.weeks.bar', {
                date: f.date(w.start),
                time: f.duration(w.seconds * 1000),
              })}
            >
              <span
                className="weeks__bar"
                style={{
                  height: `${Math.max(2, (100 * w.seconds) / Math.max(1, ...weeks.map((x) => x.seconds)))}%`,
                }}
              />
            </div>
          ))}
        </div>
        <p className="stats-note">
          {t('stats.weeks.average', { time: f.duration(weekAvg * 1000) })}
        </p>
      </section>

      {/* ---- all time ---- */}
      <section className="stats-section" aria-labelledby="stats-all">
        <h2 id="stats-all">{t('stats.alltime.title')}</h2>
        {data.allTime.firstSessionAt && (
          <p className="stats-section__lede">
            {t('stats.alltime.since', { date: f.date(data.allTime.firstSessionAt) })}
          </p>
        )}
        <dl className="stats-figures stats-figures--small">
          <div>
            <dt>{t('stats.alltime.hours')}</dt>
            <dd>{f.number(Math.round(data.allTime.seconds / 3600))}</dd>
          </div>
          <div>
            <dt>{t('stats.alltime.sittings')}</dt>
            <dd>{f.number(data.allTime.sessions)}</dd>
          </div>
          <div>
            <dt>{t('stats.alltime.finished')}</dt>
            <dd>{f.number(data.allTime.booksFinished)}</dd>
          </div>
        </dl>
        {data.truncated && <p className="stats-note">{t('stats.alltime.truncated')}</p>}
      </section>
    </main>
  );
}

/** The recommendation, phrased from the numbers rather than templated onto them. */
function BestTime({
  best,
  allMeanSitting,
  totalSeconds,
  hourLabel,
}: {
  best: NonNullable<ReturnType<typeof bestWindow>>;
  allMeanSitting: number;
  totalSeconds: number;
  hourLabel: (h: number) => string;
}) {
  const t = useT();
  const minutes = Math.round(best.meanSitting / 60);
  const ratio = allMeanSitting > 0 ? best.meanSitting / allMeanSitting : 1;
  const longerPct = Math.round((ratio - 1) * 100);
  const pace = best.paceIndex;
  const pacePct = pace !== null ? Math.round((pace - 1) * 100) : 0;
  const share = Math.round((100 * best.seconds) / Math.max(1, totalSeconds));
  return (
    <div className="best">
      <p className="best__window">
        {t('stats.best.window', { from: hourLabel(best.from), to: hourLabel(best.to % 24) })}
      </p>
      <p className="best__why">
        {longerPct >= 10
          ? t('stats.best.sittingLonger', { minutes, pct: longerPct })
          : longerPct <= -10
            ? t('stats.best.sittingShorter', { minutes })
            : t('stats.best.sittingUsual', { minutes })}{' '}
        {pace === null
          ? ''
          : pacePct >= 8
            ? t('stats.best.paceFaster', { pct: pacePct })
            : pacePct <= -8
              ? t('stats.best.paceSlower')
              : t('stats.best.paceUsual')}{' '}
        {t('stats.best.share', { pct: share })}
      </p>
      <p className="best__advice">{t('stats.best.advice')}</p>
    </div>
  );
}

/** Eight Monday-to-Sunday weeks from the daily totals, oldest first. */
function weeksOf(daily: { day: string; seconds: number }[]): { start: string; seconds: number }[] {
  const weeks: { start: string; seconds: number }[] = [];
  for (const row of daily) {
    const d = new Date(`${row.day}T00:00:00`);
    const monday = new Date(d);
    monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const key = monday.toISOString().slice(0, 10);
    const last = weeks.at(-1);
    if (last && last.start === key) last.seconds += row.seconds;
    else weeks.push({ start: key, seconds: row.seconds });
  }
  return weeks.slice(-8);
}
