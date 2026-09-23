import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  type BookSummary,
  type TranslationEvidence,
  type TranslationSuggestion,
  type TranslationTitle,
} from '@readport/shared';
import { api, ApiError, failureMessage } from '../api/client';
import { Cover, Sheet, useToast } from '../components/ui';
import { IconLink, IconSearch } from '../components/icons';
import { useT } from '../i18n';
import { useFormat } from '../i18n/useFormat';
import { type MessageKey } from '../i18n/messages/en';
import { formatLabel } from './continue';
import './translations.css';

interface TranslationsResponse {
  titles: TranslationTitle[];
  suggestions: TranslationSuggestion[];
  canLink: boolean;
}

const MATCH_NOTE: Record<TranslationTitle['match'], MessageKey> = {
  close: 'translations.match.close',
  rough: 'translations.match.rough',
  pending: 'translations.match.pending',
  none: 'translations.match.none',
};

const EVIDENCE: [keyof TranslationEvidence, MessageKey][] = [
  ['author', 'translations.evidence.author'],
  ['series', 'translations.evidence.series'],
  ['length', 'translations.evidence.length'],
  ['chapters', 'translations.evidence.chapters'],
];

/** One edition in a list: its cover, its language, its title, and what can be done with it. */
function EditionRow({
  id,
  kind,
  hasCover,
  title,
  author,
  language,
  formats,
  note,
  children,
  dimmed = false,
}: {
  id: string;
  kind: 'ebook' | 'audio';
  hasCover: boolean;
  title: string;
  author: string | null;
  language: string | null;
  formats: string;
  note?: ReactNode;
  children?: ReactNode;
  dimmed?: boolean;
}) {
  const f = useFormat();
  return (
    <li className={`edition-row${dimmed ? ' is-dimmed' : ''}`}>
      <span className="edition-cover edition-cover--sm">
        <Cover book={{ id, kind, hasCover, title, author }} />
      </span>
      <div className="edition-row__body">
        <span className="edition-row__meta">
          <strong>{f.languageName(language)}</strong>
          <span aria-hidden="true"> · </span>
          {formats}
        </span>
        <bdi className="edition-row__title" lang={language ?? undefined}>
          {title}
        </bdi>
        {author && (
          <bdi className="edition-row__author" lang={language ?? undefined}>
            {author}
          </bdi>
        )}
        {note && <span className="edition-row__note">{note}</span>}
      </div>
      {children && <div className="edition-row__actions">{children}</div>}
    </li>
  );
}

/**
 * Where a curator links a book to its editions in other languages: what is
 * linked now, what looks like it, and a search for anything the guesses
 * missed. Every change is sent to the page underneath (`onChanged`) as it
 * happens, so the row under the title is right the moment the sheet closes.
 */
export function LinkTranslationsSheet({
  book,
  onChanged,
  onClose,
}: {
  book: BookSummary;
  onChanged: (titles: TranslationTitle[]) => void;
  onClose: () => void;
}) {
  const t = useT();
  const f = useFormat();
  const toast = useToast();
  const [data, setData] = useState<TranslationsResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<BookSummary[] | null>(null);
  const [searching, setSearching] = useState(false);
  const searchSeq = useRef(0);

  useEffect(() => {
    let alive = true;
    api<TranslationsResponse>(`/api/books/${book.id}/translations`)
      .then((d) => {
        if (alive) setData(d);
      })
      .catch((err) => {
        if (alive) toast.show(failureMessage(err, t('translations.toast.failed'), t));
      });
    return () => {
      alive = false;
    };
  }, [book.id, t, toast]);

  // Search as they type, a beat after they stop.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults(null);
      return;
    }
    const seq = ++searchSeq.current;
    setSearching(true);
    const timer = setTimeout(() => {
      api<{ books: BookSummary[] }>(`/api/library?query=${encodeURIComponent(q)}&sort=title`)
        .then((r) => {
          if (seq === searchSeq.current) setResults(r.books);
        })
        .catch(() => {
          if (seq === searchSeq.current) setResults([]);
        })
        .finally(() => {
          if (seq === searchSeq.current) setSearching(false);
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  /** "EPUB · AUDIO": a title's formats, as the library's badges name them. */
  const formatsOf = (books: { kind: 'ebook' | 'audio'; format: string }[]) =>
    books.map((b) => formatLabel(b, t('library.card.audioFormat'))).join(' · ');
  const linkedIds = new Set((data?.titles ?? []).flatMap((x) => x.books.map((b) => b.id)));
  const mine = new Set([book.id, ...(book.pair ? [book.pair.otherBookId] : [])]);

  const errorText = (err: unknown) =>
    err instanceof ApiError && err.code === 'same-language'
      ? t('translations.error.sameLanguage')
      : err instanceof ApiError && err.code === 'same-title'
        ? t('translations.error.sameTitle')
        : failureMessage(err, t('translations.toast.failed'), t);

  const link = async (otherId: string, language: string | null) => {
    setBusy(otherId);
    try {
      const res = await api<{ titles: TranslationTitle[] }>(`/api/books/${book.id}/translations`, {
        method: 'POST',
        body: { otherBookId: otherId },
      });
      onChanged(res.titles);
      const linked = new Set(res.titles.flatMap((x) => x.books.map((b) => b.id)));
      setData((d) =>
        d
          ? {
              ...d,
              titles: res.titles,
              suggestions: d.suggestions.filter((s) => !s.books.some((b) => linked.has(b.id))),
            }
          : d,
      );
      toast.show(t('translations.toast.linked', { language: f.languageName(language) }));
    } catch (err) {
      toast.show(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const unlink = async (otherId: string, language: string | null) => {
    setBusy(otherId);
    try {
      const res = await api<{ titles: TranslationTitle[] }>(
        `/api/books/${book.id}/translations/${otherId}`,
        { method: 'DELETE' },
      );
      onChanged(res.titles);
      setConfirm(null);
      setData((d) => (d ? { ...d, titles: res.titles } : d));
      toast.show(t('translations.toast.unlinked', { language: f.languageName(language) }));
    } catch (err) {
      toast.show(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const dismiss = async (otherId: string) => {
    setBusy(otherId);
    try {
      await api(`/api/books/${book.id}/translations/dismiss`, {
        method: 'POST',
        body: { otherBookId: otherId },
      });
      setData((d) =>
        d
          ? {
              ...d,
              suggestions: d.suggestions.filter((s) => !s.books.some((b) => b.id === otherId)),
            }
          : d,
      );
      toast.show(t('translations.toast.dismissed'));
    } catch (err) {
      toast.show(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const found = (results ?? []).filter(
    (b) =>
      !mine.has(b.id) && !linkedIds.has(b.id) && !(b.pair && linkedIds.has(b.pair.otherBookId)),
  );

  return (
    <Sheet title={t('translations.sheet.title')} onClose={onClose}>
      <p className="sheet__lede">{t('translations.sheet.lede')}</p>
      {!data ? (
        <div aria-busy="true">
          <div className="skeleton" style={{ height: 64, marginBlockEnd: 10 }} />
          <div className="skeleton" style={{ height: 64 }} />
        </div>
      ) : (
        <>
          {data.titles.length > 0 && (
            <section className="edition-section" aria-labelledby="tr-linked">
              <h3 id="tr-linked" className="edition-section__title">
                {t('translations.sheet.linked')}
              </h3>
              <ul className="edition-list">
                {data.titles.map((x) => {
                  const lead = x.books[0]!;
                  return (
                    <EditionRow
                      key={lead.id}
                      id={lead.id}
                      kind={lead.kind}
                      hasCover={lead.hasCover}
                      title={x.title}
                      author={x.author}
                      language={x.language}
                      formats={formatsOf(x.books)}
                      note={t(MATCH_NOTE[x.match])}
                    >
                      {confirm === lead.id ? (
                        <>
                          <button
                            type="button"
                            className="btn btn--danger btn--sm"
                            disabled={busy !== null}
                            onClick={() => void unlink(lead.id, x.language)}
                          >
                            {t('translations.sheet.unlinkYes')}
                          </button>
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            onClick={() => setConfirm(null)}
                          >
                            {t('translations.sheet.keep')}
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          disabled={busy !== null}
                          onClick={() => setConfirm(lead.id)}
                        >
                          {t('translations.sheet.unlink')}
                        </button>
                      )}
                    </EditionRow>
                  );
                })}
              </ul>
            </section>
          )}

          {data.suggestions.length > 0 && (
            <section className="edition-section" aria-labelledby="tr-suggested">
              <h3 id="tr-suggested" className="edition-section__title">
                {t('translations.sheet.suggested')}
              </h3>
              <ul className="edition-list">
                {data.suggestions.map((s) => {
                  const lead = s.books[0]!;
                  const why = EVIDENCE.filter(([k]) => s.evidence[k]).map(([, key]) => t(key));
                  return (
                    <EditionRow
                      key={lead.id}
                      id={lead.id}
                      kind={lead.kind}
                      hasCover={lead.hasCover}
                      title={s.title}
                      author={s.author}
                      language={s.language}
                      formats={formatsOf(s.books)}
                      note={why.join(' · ')}
                    >
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        disabled={busy !== null}
                        onClick={() => void link(lead.id, s.language)}
                      >
                        <IconLink size={15} />
                        {busy === lead.id
                          ? t('translations.sheet.linking')
                          : t('translations.sheet.link')}
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        disabled={busy !== null}
                        onClick={() => void dismiss(lead.id)}
                      >
                        {t('translations.sheet.notThis')}
                      </button>
                    </EditionRow>
                  );
                })}
              </ul>
            </section>
          )}

          <section className="edition-section" aria-labelledby="tr-find">
            <h3 id="tr-find" className="edition-section__title">
              {t('translations.sheet.find')}
            </h3>
            <label className="edition-search">
              <IconSearch size={16} />
              <span className="visually-hidden">{t('translations.sheet.search')}</span>
              <input
                type="search"
                value={query}
                placeholder={t('translations.sheet.search')}
                onChange={(e) => setQuery(e.target.value)}
                autoComplete="off"
                enterKeyHint="search"
              />
            </label>
            {searching && results === null && (
              <p className="edition-section__hint" role="status">
                {t('translations.sheet.searching')}
              </p>
            )}
            {results !== null &&
              (found.length === 0 ? (
                <p className="edition-section__hint" role="status">
                  {t('translations.sheet.noResults')}
                </p>
              ) : (
                <ul className="edition-list">
                  {found.slice(0, 8).map((b) => {
                    const same = !!b.language && !!book.language && b.language === book.language;
                    const formats = formatsOf([
                      b,
                      ...(b.pair ? [{ kind: b.pair.otherKind, format: b.pair.otherFormat }] : []),
                    ]);
                    return (
                      <EditionRow
                        key={b.id}
                        id={b.id}
                        kind={b.kind}
                        hasCover={b.hasCover}
                        title={b.title}
                        author={b.author}
                        language={b.language}
                        formats={formats}
                        note={same ? t('translations.sheet.sameLanguage') : undefined}
                        dimmed={same}
                      >
                        <button
                          type="button"
                          className="btn btn--secondary btn--sm"
                          disabled={busy !== null || same}
                          onClick={() => void link(b.id, b.language)}
                        >
                          <IconLink size={15} />
                          {busy === b.id
                            ? t('translations.sheet.linking')
                            : t('translations.sheet.link')}
                        </button>
                      </EditionRow>
                    );
                  })}
                </ul>
              ))}
          </section>
        </>
      )}
    </Sheet>
  );
}
