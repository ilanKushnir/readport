import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { type TranslationEvidence, type TranslationPairSuggestion } from '@readport/shared';
import { api, failureMessage } from '../api/client';
import { Cover, useToast } from '../components/ui';
import { IconLanguages, IconLink } from '../components/icons';
import { useT } from '../i18n';
import { useFormat } from '../i18n/useFormat';
import { type MessageKey } from '../i18n/messages/en';
import { formatLabel } from './continue';
import './translations.css';

type Side = TranslationPairSuggestion['a'];

const EVIDENCE: [keyof TranslationEvidence, MessageKey][] = [
  ['author', 'translations.evidence.author'],
  ['series', 'translations.evidence.series'],
  ['length', 'translations.evidence.length'],
  ['chapters', 'translations.evidence.chapters'],
];

function Edition({ side }: { side: Side }) {
  const t = useT();
  const f = useFormat();
  const lead = side.books[0]!;
  return (
    <Link to={`/book/${lead.id}`} className="tr-pair__side">
      <span className="edition-cover edition-cover--sm">
        <Cover
          book={{
            id: lead.id,
            kind: lead.kind,
            hasCover: lead.hasCover,
            title: side.title,
            author: side.author,
          }}
        />
      </span>
      <span className="tr-pair__text">
        <span className="edition-row__meta">
          <strong>{f.languageName(side.language)}</strong>
          <span aria-hidden="true"> · </span>
          {side.books.map((b) => formatLabel(b, t('library.card.audioFormat'))).join(' · ')}
        </span>
        <bdi className="edition-row__title" lang={side.language ?? undefined}>
          {side.title}
        </bdi>
        {side.author && (
          <bdi className="edition-row__author" lang={side.language ?? undefined}>
            {side.author}
          </bdi>
        )}
      </span>
    </Link>
  );
}

/**
 * Every likely translation in the library, on the pairing page: a curator
 * with a shelf of books in two languages links them here in one sitting
 * instead of opening each book. Nothing at all when there is nothing to
 * review - the page has enough on it.
 */
export function TranslationReview() {
  const t = useT();
  const f = useFormat();
  const toast = useToast();
  const [list, setList] = useState<TranslationPairSuggestion[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api<{ suggestions: TranslationPairSuggestion[] }>('/api/translations/suggestions')
      .then((r) => {
        if (alive) setList(r.suggestions);
      })
      .catch(() => {
        if (alive) setList([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!list || list.length === 0) return null;

  const key = (s: TranslationPairSuggestion) => `${s.a.books[0]!.id}|${s.b.books[0]!.id}`;
  const act = async (s: TranslationPairSuggestion, link: boolean) => {
    const a = s.a.books[0]!.id;
    const b = s.b.books[0]!.id;
    setBusy(key(s));
    try {
      await api(`/api/books/${a}/translations${link ? '' : '/dismiss'}`, {
        method: 'POST',
        body: { otherBookId: b },
      });
      // Linking one pair can settle others that shared a title with it.
      setList((l) =>
        (l ?? []).filter((x) => {
          if (key(x) === key(s)) return false;
          if (!link) return true;
          const ids = [...x.a.books, ...x.b.books].map((bk) => bk.id);
          const done = [...s.a.books, ...s.b.books].map((bk) => bk.id);
          return !(ids.filter((id) => done.includes(id)).length >= 2);
        }),
      );
      toast.show(
        link
          ? t('translations.toast.linked', { language: f.languageName(s.b.language) })
          : t('translations.toast.dismissed'),
      );
    } catch (err) {
      toast.show(failureMessage(err, t('translations.toast.failed'), t));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="panel tr-review" aria-labelledby="tr-review-title">
      <h2 id="tr-review-title" className="tr-review__title">
        <IconLanguages size={18} />
        {t('translations.review.title')}
        <span className="tr-review__count">{list.length}</span>
      </h2>
      <p className="tr-review__lede">{t('translations.review.lede')}</p>
      <ul className="edition-list">
        {list.map((s) => {
          const why = EVIDENCE.filter(([k]) => s.evidence[k]).map(([, k]) => t(k));
          return (
            <li key={key(s)} className="tr-pair">
              <div className="tr-pair__sides">
                <Edition side={s.a} />
                <span className="tr-pair__join" aria-hidden="true">
                  ⇄
                </span>
                <Edition side={s.b} />
              </div>
              <div className="tr-pair__foot">
                <span className="edition-row__note">{why.join(' · ')}</span>
                <span className="tr-pair__actions">
                  <button
                    type="button"
                    className="btn btn--secondary btn--sm"
                    disabled={busy !== null}
                    onClick={() => void act(s, true)}
                  >
                    <IconLink size={15} />
                    {busy === key(s)
                      ? t('translations.sheet.linking')
                      : t('translations.sheet.link')}
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={busy !== null}
                    onClick={() => void act(s, false)}
                  >
                    {t('translations.sheet.notThis')}
                  </button>
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
