import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { type BookPairing, type BookSummary } from '@readport/shared';
import { api, failureMessage } from '../api/client';
import { Sheet, useToast } from './ui';
import { EditionRow } from './EditionRow';
import { IconLink, IconSearch } from './icons';
import { useT } from '../i18n';
import { useFormat } from '../i18n/useFormat';
import { searchNames } from '../lib/nameSearch';
import { formatLabel } from '../translations/continue';

/** Rows shown before "Show all": the likeliest are at the top anyway. */
const FIRST_ROWS = 30;

/** Isolated, so a title in another direction cannot reorder the sentence around it. */
const iso = (title: string) => `\u2068${title}\u2069`;

/**
 * Pairing a book from its own page: the edition it is paired with, what the
 * library scan suggested for it, and every book of the other format to pick
 * from - the likeliest first, found by title or author. A pick is THE other
 * edition: whatever either book was paired with before is let go, after
 * asking when that would take a book from its current pair.
 *
 * Every change reaches the page underneath (`onChanged`) as it happens, so
 * its Listen and Read along buttons are right the moment the sheet closes.
 */
export function PairSheet({
  book,
  onChanged,
  onClose,
}: {
  book: BookSummary;
  onChanged: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const f = useFormat();
  const toast = useToast();
  const [data, setData] = useState<BookPairing | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  /** The row asking "are you sure?" before it unpairs or takes a book from its pair. */
  const [asking, setAsking] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [all, setAll] = useState(false);

  const load = useCallback(
    () =>
      api<BookPairing>(`/api/books/${book.id}/pairing`).then(
        (d) => {
          setData(d);
          setFailed(false);
        },
        () => setFailed(true),
      ),
    [book.id],
  );
  useEffect(() => {
    void load();
  }, [load]);

  /** "EPUB" or "MP3 · 6:12:40": what the file is, and how long a narration runs. */
  const metaOf = (b: BookSummary) =>
    [formatLabel(b, t('library.card.audioFormat')), b.durationMs ? f.duration(b.durationMs) : null]
      .filter(Boolean)
      .join(' · ');

  const act = async (key: string, run: () => Promise<unknown>, done: string) => {
    setBusy(key);
    try {
      await run();
      setAsking(null);
      toast.show(done);
      await load();
      onChanged();
    } catch (err) {
      toast.show(failureMessage(err, t('library.pairing.toast.failed'), t));
    } finally {
      setBusy(null);
    }
  };

  const pair = (other: BookSummary) =>
    act(
      other.id,
      () =>
        api('/api/pairs/link', {
          method: 'POST',
          body: {
            ebookId: book.kind === 'ebook' ? book.id : other.id,
            audioId: book.kind === 'ebook' ? other.id : book.id,
            replace: true,
          },
        }),
      t('library.pairing.toast.paired', { title: iso(other.title) }),
    );
  const unpair = (pairId: string) =>
    act(
      pairId,
      () => api(`/api/pairs/${pairId}/unlink`, { method: 'POST' }),
      t('library.pairing.toast.unpaired'),
    );
  const dismiss = (pairId: string) =>
    act(
      pairId,
      () => api(`/api/pairs/${pairId}/reject`, { method: 'POST' }),
      t('library.pairing.toast.dismissed'),
    );

  const found = useMemo(
    () =>
      searchNames(
        (data?.options ?? []).map((o) => ({
          ...o,
          names: [o.book.title, o.book.author ?? '', o.book.series ?? ''],
        })),
        query,
      ),
    [data, query],
  );
  const shown = all || query.trim() ? found : found.slice(0, FIRST_ROWS);
  const current = data?.linked[0] ?? null;

  return (
    <Sheet size="wide" title={t('library.pairing.title', { kind: book.kind })} onClose={onClose}>
      <p className="sheet__lede">{t('library.pairing.lede', { kind: book.kind })}</p>
      {!data ? (
        failed ? (
          <p className="edition-section__hint" role="alert">
            {t('library.pairing.loadFailed')}
          </p>
        ) : (
          <div aria-busy="true">
            <div className="skeleton" style={{ height: 64, marginBlockEnd: 10 }} />
            <div className="skeleton" style={{ height: 64 }} />
          </div>
        )
      ) : (
        <>
          {data.linked.length > 0 && (
            <section className="edition-section" aria-labelledby="pair-linked">
              <h3 id="pair-linked" className="edition-section__title">
                {t('library.pairing.linked')}
              </h3>
              <ul className="edition-list">
                {data.linked.map((l) => (
                  <EditionRow
                    key={l.pairId}
                    id={l.book.id}
                    kind={l.book.kind}
                    hasCover={l.book.hasCover}
                    title={l.book.title}
                    author={l.book.author}
                    language={l.book.language}
                    formats={metaOf(l.book)}
                    note={t(
                      l.switchable ? 'library.pairing.aligned' : 'library.pairing.notAligned',
                    )}
                  >
                    {asking === l.pairId ? (
                      <>
                        <span className="edition-row__ask">{t('library.pairing.unpairAsk')}</span>
                        <button
                          type="button"
                          className="btn btn--danger btn--sm"
                          disabled={busy !== null}
                          onClick={() => void unpair(l.pairId)}
                        >
                          {t('library.pairing.unpairYes')}
                        </button>
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          onClick={() => setAsking(null)}
                        >
                          {t('common.cancel')}
                        </button>
                      </>
                    ) : (
                      <>
                        <Link
                          to={`/book/${l.book.id}`}
                          className="btn btn--secondary btn--sm"
                          onClick={onClose}
                        >
                          {t('library.pairing.open')}
                        </Link>
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          disabled={busy !== null}
                          onClick={() => setAsking(l.pairId)}
                        >
                          {t('library.pairing.unpair')}
                        </button>
                      </>
                    )}
                  </EditionRow>
                ))}
              </ul>
            </section>
          )}

          {data.suggested.length > 0 && (
            <section className="edition-section" aria-labelledby="pair-suggested">
              <h3 id="pair-suggested" className="edition-section__title">
                {t('library.pairing.suggested')}
              </h3>
              <ul className="edition-list">
                {data.suggested.map((s) => (
                  <EditionRow
                    key={s.pairId}
                    id={s.book.id}
                    kind={s.book.kind}
                    hasCover={s.book.hasCover}
                    title={s.book.title}
                    author={s.book.author}
                    language={s.book.language}
                    formats={metaOf(s.book)}
                    note={t('library.pairing.suggestedNote')}
                  >
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      disabled={busy !== null}
                      onClick={() => void pair(s.book)}
                    >
                      <IconLink size={15} />
                      {busy === s.book.id
                        ? t('library.pairing.pairing')
                        : t('library.pairing.pair')}
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      disabled={busy !== null}
                      onClick={() => void dismiss(s.pairId)}
                    >
                      {t('library.pairing.notMatch')}
                    </button>
                  </EditionRow>
                ))}
              </ul>
            </section>
          )}

          <section className="edition-section" aria-labelledby="pair-choose">
            <h3 id="pair-choose" className="edition-section__title">
              {t('library.pairing.choose', { kind: book.kind })}
            </h3>
            {data.options.length === 0 ? (
              <p className="edition-section__hint">
                {data.linked.length + data.suggested.length === 0
                  ? t('library.pairing.none', { kind: book.kind })
                  : t('library.pairing.noOthers', { kind: book.kind })}
              </p>
            ) : (
              <>
                <label className="edition-search">
                  <IconSearch size={16} />
                  <span className="visually-hidden">{t('library.pairing.search')}</span>
                  <input
                    type="search"
                    value={query}
                    placeholder={t('library.pairing.search')}
                    onChange={(e) => setQuery(e.target.value)}
                    autoComplete="off"
                    enterKeyHint="search"
                  />
                </label>
                {found.length === 0 ? (
                  <p className="edition-section__hint" role="status">
                    {t('library.pairing.noMatch', { query: query.trim() })}
                  </p>
                ) : (
                  <ul className="edition-list">
                    {shown.map((o) => {
                      const notes = [
                        o.likely ? t('library.pairing.likely') : null,
                        o.pairedWith
                          ? t('library.pairing.pairedWith', { title: iso(o.pairedWith.title) })
                          : null,
                        o.dismissed ? t('library.pairing.dismissed') : null,
                      ].filter(Boolean);
                      // Taking a book from its pair, or this one from its own,
                      // is asked about first; a free pick is not.
                      const question = o.pairedWith
                        ? t('library.pairing.moveAsk', { title: iso(o.pairedWith.title) })
                        : current
                          ? t('library.pairing.replaceAsk', { title: iso(current.book.title) })
                          : null;
                      return (
                        <EditionRow
                          key={o.book.id}
                          id={o.book.id}
                          kind={o.book.kind}
                          hasCover={o.book.hasCover}
                          title={o.book.title}
                          author={o.book.author}
                          language={o.book.language}
                          formats={metaOf(o.book)}
                          note={notes.length ? notes.join(' · ') : undefined}
                        >
                          {asking === o.book.id && question ? (
                            <>
                              <span className="edition-row__ask">{question}</span>
                              <button
                                type="button"
                                className="btn btn--secondary btn--sm"
                                disabled={busy !== null}
                                onClick={() => void pair(o.book)}
                              >
                                <IconLink size={15} />
                                {busy === o.book.id
                                  ? t('library.pairing.pairing')
                                  : t('library.pairing.pair')}
                              </button>
                              <button
                                type="button"
                                className="btn btn--ghost btn--sm"
                                onClick={() => setAsking(null)}
                              >
                                {t('common.cancel')}
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              className={`btn btn--sm ${o.likely ? 'btn--secondary' : 'btn--ghost'}`}
                              disabled={busy !== null}
                              onClick={() => (question ? setAsking(o.book.id) : void pair(o.book))}
                            >
                              <IconLink size={15} />
                              {busy === o.book.id
                                ? t('library.pairing.pairing')
                                : question
                                  ? t('library.pairing.pairInstead')
                                  : t('library.pairing.pair')}
                            </button>
                          )}
                        </EditionRow>
                      );
                    })}
                  </ul>
                )}
                {shown.length < found.length && (
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm pair-sheet__more"
                    onClick={() => setAll(true)}
                  >
                    {t('library.pairing.showAll', { n: found.length })}
                  </button>
                )}
              </>
            )}
          </section>

          <p className="pair-sheet__foot">
            <Link to="/pairs" onClick={onClose}>
              {t('library.pairing.allPairs')}
            </Link>
          </p>
        </>
      )}
    </Sheet>
  );
}
