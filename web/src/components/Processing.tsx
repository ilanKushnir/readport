import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { type Job } from '@readport/shared';
import { api, failureMessage } from '../api/client';
import { useT, type TranslateFn } from '../i18n';
import { useFormat } from '../i18n/useFormat';
import { en, type MessageKey } from '../i18n/messages/en';
import { alignerModel, type ModelsResponse } from '../lib/types';
import { IconAlert, IconCheck, IconClose, IconHeadphones, IconBookOpen } from './icons';
import { useToast } from './ui';

const ACTIVE = new Set(['queued', 'running']);

/** Keys are the server's real job types (server/src/jobs/handlers.ts). */
const TYPE_KEY: Record<string, MessageKey | undefined> = {
  align: 'shell.jobType.align',
  'model-download': 'shell.jobType.model-download',
  scan: 'shell.jobType.scan',
  'index-ebook': 'shell.jobType.index-ebook',
  'index-audio': 'shell.jobType.index-audio',
  'pair-scan': 'shell.jobType.pair-scan',
};

const STATE_KEY: Record<string, MessageKey | undefined> = {
  queued: 'shell.jobState.queued',
  running: 'shell.jobState.running',
  done: 'shell.jobState.done',
  failed: 'shell.jobState.failed',
  cancelled: 'shell.jobState.cancelled',
};

/**
 * What the label helpers need: the app's `t`, or - for a caller with no
 * hook in reach - English straight from the catalog.
 */
export type LabelT = (key: MessageKey) => string;
const english: LabelT = (key) => en[key];

export function typeLabel(type: string, t: LabelT = english): string {
  const key = TYPE_KEY[type];
  if (key) return t(key);
  // A type the catalog does not know: the server's own identifier, made readable.
  const words = type.replace(/[-_]/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A job state as a word, not as the enum the scheduler happens to use. */
export function stateLabel(state: string, t: LabelT = english): string {
  return t(STATE_KEY[state] ?? 'shell.jobState.queued');
}

/** Which of the three scheduler lanes a job waits in. */
function laneOf(t: string): 'alignment' | 'download' | 'library' {
  if (t === 'align') return 'alignment';
  if (t === 'model-download') return 'download';
  return 'library';
}

function elapsed(fromIso: string | null, t: TranslateFn): string | null {
  if (!fromIso) return null;
  const s = Math.max(0, (Date.now() - Date.parse(fromIso)) / 1000);
  if (s < 60) return t('shell.job.elapsedSeconds', { n: Math.round(s) });
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h > 0
    ? t('shell.job.elapsedHoursMinutes', { h, m })
    : t('shell.job.elapsedMinutes', { m });
}

/**
 * The first (time, progress) pair actually seen for a job, per job id.
 *
 * Remaining time used to be `spent / progress × (1 − progress)`, which assumes
 * the bar was at zero when the clock started. It never is: a job reports a
 * little progress the moment it has set itself up, and dividing the whole
 * elapsed time by that pedestal makes the work look far faster than it is -
 * the reason an alignment that takes thirteen minutes announced eight.
 * Measuring the rate between two observed points removes the assumption, and
 * with it any sensitivity to where the bar starts.
 */
const firstSeen = new Map<string, { t: number; p: number }>();

/** Rough remaining time in milliseconds, measured from this job's own observed rate. */
function etaMs(jobId: string, startedAt: string | null, progress: number): number | null {
  if (!startedAt || progress >= 0.995) {
    firstSeen.delete(jobId);
    return null;
  }
  const now = Date.now();
  const first = firstSeen.get(jobId);
  if (!first) {
    firstSeen.set(jobId, { t: now, p: progress });
    return null;
  }
  const dp = progress - first.p;
  const dt = now - first.t;
  // Enough of both to mean anything, and never from a bar that went backwards.
  if (dp <= 0.02 || dt < 45_000) return null;
  return (dt / dp) * (1 - progress);
}

/**
 * Live view of the job queue: what is running right now (with the alignment
 * engine's own progress), what is waiting behind it, and the last few
 * outcomes. Polls quickly while anything is active and slowly otherwise.
 */
export function ProcessingQueue({
  canManage,
  onChange,
  quietWhenIdle = false,
}: {
  canManage: boolean;
  onChange?: () => void;
  /**
   * With nothing running, fold to one line: the idle lede and the way to
   * recent results. A page whose real content sits below should not open
   * with a panel saying nothing is happening.
   */
  quietWhenIdle?: boolean;
}) {
  const t = useT();
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [showDone, setShowDone] = useState(false);
  const toast = useToast();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeCountRef = useRef(0);

  const load = useCallback(async () => {
    try {
      const res = await api<{ jobs: Job[] }>('/api/jobs');
      setJobs(res.jobs);
      const n = res.jobs.filter((j) => ACTIVE.has(j.state)).length;
      if (n !== activeCountRef.current) onChange?.();
      activeCountRef.current = n;
      return n;
    } catch {
      return 0;
    }
  }, [onChange]);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const n = await load();
      if (!alive) return;
      timer.current = setTimeout(() => void tick(), n > 0 ? 2500 : 20_000);
    };
    void tick();
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        if (timer.current) clearTimeout(timer.current);
        void tick();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      alive = false;
      if (timer.current) clearTimeout(timer.current);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [load]);

  const act = async (job: Job, what: 'cancel' | 'retry') => {
    try {
      await api(`/api/jobs/${job.id}/${what}`, { method: 'POST' });
      toast.show(what === 'cancel' ? t('shell.queue.cancelled') : t('shell.queue.retried'));
      await load();
    } catch (err) {
      toast.show(failureMessage(err, t('shell.queue.actionFailed'), t));
    }
  };

  if (!jobs) return null;
  const running = jobs.filter((j) => j.state === 'running');
  const queued = jobs.filter((j) => j.state === 'queued');
  const done = jobs
    .filter((j) => !ACTIVE.has(j.state))
    .sort(
      (a, b) => Date.parse(b.finishedAt ?? b.createdAt) - Date.parse(a.finishedAt ?? a.createdAt),
    )
    .slice(0, 8);
  const idle = running.length === 0 && queued.length === 0;

  if (idle && quietWhenIdle) {
    return (
      <section
        className="queue queue--quiet"
        aria-label={t('shell.queue.label')}
        aria-live="polite"
      >
        <span className="queue__dot" aria-hidden="true" />
        <span className="queue__lede">{t('shell.queue.idleLede')}</span>
        {done.length > 0 && (
          <button className="queue__toggle" onClick={() => setShowDone((v) => !v)}>
            {showDone
              ? t('shell.queue.hideRecent', { n: done.length })
              : t('shell.queue.showRecent', { n: done.length })}
          </button>
        )}
        {showDone && (
          <div className="queue__list queue__list--done">
            {done.map((j) => (
              <JobRow key={j.id} job={j} canManage={canManage} onAct={act} />
            ))}
          </div>
        )}
      </section>
    );
  }

  return (
    <section className="queue" aria-label={t('shell.queue.label')} aria-live="polite">
      <div className="queue__head">
        <div>
          <h2 className="section-title" style={{ margin: 0 }}>
            {t('shell.queue.heading')}
            {!idle && (
              <span className="section-title__count">
                {t('shell.queue.running', { n: running.length })}
                {queued.length > 0 ? ` · ${t('shell.queue.waiting', { n: queued.length })}` : ''}
              </span>
            )}
          </h2>
          <p className="queue__lede">
            {idle ? t('shell.queue.idleLede') : t('shell.queue.busyLede')}
          </p>
        </div>
        <span className={`queue__dot ${idle ? '' : 'is-live'}`} aria-hidden="true" />
      </div>

      {running.map((j) => (
        <JobRow key={j.id} job={j} canManage={canManage} onAct={act} live />
      ))}
      {queued.length > 0 && (
        <ol className="queue__list" aria-label={t('shell.queue.waitingList')}>
          {queued.map((j, i) => (
            <JobRow key={j.id} job={j} canManage={canManage} onAct={act} position={i + 1} />
          ))}
        </ol>
      )}
      {done.length > 0 && (
        <>
          <button className="queue__toggle" onClick={() => setShowDone((v) => !v)}>
            {showDone
              ? t('shell.queue.hideRecent', { n: done.length })
              : t('shell.queue.showRecent', { n: done.length })}
          </button>
          {showDone && (
            <div className="queue__list queue__list--done">
              {done.map((j) => (
                <JobRow key={j.id} job={j} canManage={canManage} onAct={act} />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function JobRow({
  job,
  canManage,
  onAct,
  live,
  position,
}: {
  job: Job;
  canManage: boolean;
  onAct: (job: Job, what: 'cancel' | 'retry') => void;
  live?: boolean;
  position?: number;
}) {
  const t = useT();
  const f = useFormat();
  const pct = Math.round(job.progress * 100);
  const failed = job.state === 'failed';
  const modelMissing = failed && (job.error ?? '').startsWith('model-missing:');
  const errorText = modelMissing ? (job.error ?? '').split('|').slice(1).join('|') : job.error;
  const subject = job.subject;
  const target = subject?.pairId
    ? `#pair-${subject.pairId}`
    : subject?.bookId
      ? `/book/${subject.bookId}`
      : null;
  const Icon =
    job.type === 'align' ? IconHeadphones : job.type === 'model-download' ? IconBookOpen : null;
  // Housekeeping jobs (library scan, pair scan) have no subject of their own:
  // name them once instead of printing the same words twice.
  const title = subject?.title ?? typeLabel(job.type, t);
  const spent = live ? elapsed(job.startedAt, t) : null;
  const remaining = live ? etaMs(job.id, job.startedAt, job.progress) : null;
  // The server's own progress note is shown as it came, isolated so a
  // left-to-right path or title sits right inside a right-to-left line.
  const liveParts: ReactNode[] = [];
  if (job.detail) liveParts.push(<bdi key="detail">{job.detail}</bdi>);
  if (spent) liveParts.push(t('shell.job.runningFor', { spent }));
  if (remaining != null) liveParts.push(t('format.left', { duration: f.span(remaining) }));
  return (
    <div className={`jobrow ${live ? 'jobrow--live' : ''} jobrow--${job.state}`}>
      <div className="jobrow__lead">
        {position != null ? (
          <span className="jobrow__pos">{f.number(position)}</span>
        ) : job.state === 'done' ? (
          <IconCheck size={16} />
        ) : failed ? (
          <IconAlert size={16} />
        ) : job.state === 'cancelled' ? (
          <IconClose size={16} />
        ) : Icon ? (
          <Icon size={16} />
        ) : null}
      </div>
      <div className="jobrow__body">
        <div className="jobrow__title">
          {target && target.startsWith('/') ? (
            <Link to={target}>{title}</Link>
          ) : target ? (
            <a href={target}>{title}</a>
          ) : (
            title
          )}
          {subject?.title && <span className="jobrow__type">{typeLabel(job.type, t)}</span>}
        </div>
        <div className="jobrow__meta">
          {live
            ? liveParts.length > 0
              ? liveParts.map((part, i) => (
                  <Fragment key={i}>
                    {i > 0 && ' · '}
                    {part}
                  </Fragment>
                ))
              : t('shell.job.starting')
            : null}
          {!live && job.state === 'queued'
            ? t('shell.job.waitingForLane', { lane: laneOf(job.type) })
            : null}
          {!live && job.state !== 'queued' ? (
            <>
              {stateLabel(job.state, t)} {f.ago(job.finishedAt, '')}
              {errorText ? (
                <>
                  {' · '}
                  <bdi>{errorText}</bdi>
                </>
              ) : (
                ''
              )}
            </>
          ) : null}
        </div>
        {live && (
          <div
            className="progressbar jobrow__bar"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span style={{ width: `${Math.max(2, pct)}%` }} />
          </div>
        )}
      </div>
      <div className="jobrow__side">
        {live && <span className="jobrow__pct">{f.percent(job.progress)}</span>}
        {canManage && (job.state === 'queued' || job.state === 'running') && (
          <button
            className="btn btn--ghost btn--sm"
            onClick={() => onAct(job, 'cancel')}
            aria-label={t('shell.job.cancel')}
          >
            {t('common.cancel')}
          </button>
        )}
        {canManage && failed && !modelMissing && (
          <button className="btn btn--ghost btn--sm" onClick={() => onAct(job, 'retry')}>
            {t('common.retry')}
          </button>
        )}
        {modelMissing && (
          <Link className="btn btn--ghost btn--sm" to="/settings#alignment">
            {t('shell.job.getModel')}
          </Link>
        )}
      </div>
    </div>
  );
}

/**
 * The "what actually happens" diagram for forced alignment: audio → ffmpeg →
 * an acoustic model reporting sounds every 20 ms → the ebook reduced to the
 * same alphabet → passages unique on both sides pin the two together →
 * a sentence↔second map used for switching.
 *
 * Deliberately does NOT promise a transcript: nothing here decides which
 * words were said, which is exactly why it is fast and language-agnostic.
 */
export function PipelineDiagram() {
  const t = useT();
  const f = useFormat();
  const [models, setModels] = useState<ModelsResponse | null>(null);
  useEffect(() => {
    void api<ModelsResponse>('/api/models')
      .then(setModels)
      .catch(() => setModels(null));
  }, []);
  const aligner = alignerModel(models);
  const steps: { n: number; title: string; body: string; tag?: string }[] = [
    {
      n: 1,
      title: t('common.audiobook'),
      body: t('shell.pipeline.audiobookBody'),
      tag: 'ffmpeg',
    },
    {
      n: 2,
      title: t('shell.pipeline.listeningTitle'),
      body: t('shell.pipeline.listeningBody'),
      tag: !aligner
        ? t('shell.pipeline.tagAcousticModel')
        : aligner.installed
          ? t('shell.pipeline.tagAlignerInstalled')
          : t('shell.pipeline.tagAlignerMissing'),
    },
    {
      n: 3,
      title: t('shell.pipeline.textTitle'),
      body: t('shell.pipeline.textBody'),
      tag: t('shell.pipeline.tagLetters'),
    },
    {
      n: 4,
      title: t('shell.pipeline.pinningTitle'),
      body: t('shell.pipeline.pinningBody'),
      tag: t('shell.pipeline.tagPins'),
    },
    {
      n: 5,
      title: t('shell.pipeline.mapTitle'),
      body: t('shell.pipeline.mapBody'),
      tag: t('shell.pipeline.tagMap'),
    },
  ];
  return (
    <div className="pipeline">
      {steps.map((s, i) => (
        <div key={s.n} className={`pipeline__step pipeline__step--${s.n}`}>
          <div className="pipeline__num">{f.number(s.n)}</div>
          <div className="pipeline__title">{s.title}</div>
          <p className="pipeline__body">{s.body}</p>
          {s.tag && <span className="pipeline__tag">{s.tag}</span>}
          {i < steps.length - 1 && <span className="pipeline__arrow" aria-hidden="true" />}
        </div>
      ))}
      <p className="pipeline__foot">
        {t('shell.pipeline.footSetup')}{' '}
        <Link to="/settings#alignment">{t('shell.pipeline.footSettingsLink')}</Link>.{' '}
        {t('shell.pipeline.footDetail', { appName: t('common.appName') })}
      </p>
    </div>
  );
}
