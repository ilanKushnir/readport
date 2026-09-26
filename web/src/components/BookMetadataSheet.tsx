import { useEffect, useState, type ReactNode } from 'react';
import { type BookMetadata } from '@readport/shared';
import { api } from '../api/client';
import { Sheet, useToast } from './ui';
import { useT } from '../i18n';
import { useFormat } from '../i18n/useFormat';
import { formatDuration } from '../lib/format';
import { COVER_SOURCE_NAME } from '../lib/cover';

/**
 * A book's metadata, for an admin: the file and where it is on the server's
 * disk, what the file says about itself, and what ReadPort made of it. For
 * the questions a library raises - which of two files is this, why is its
 * language wrong, where did its cover come from - without a terminal.
 */
export function BookMetadataSheet({ bookId, onClose }: { bookId: string; onClose: () => void }) {
  const t = useT();
  const f = useFormat();
  const toast = useToast();
  const [data, setData] = useState<BookMetadata | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    api<BookMetadata>(`/api/books/${bookId}/metadata`).then(
      (d) => {
        if (alive) setData(d);
      },
      () => {
        if (alive) setFailed(true);
      },
    );
    return () => {
      alive = false;
    };
  }, [bookId]);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.show(t('library.meta.copied'));
    } catch {
      toast.show(t('library.meta.copyFailed'));
    }
  };

  const when = (iso: string | null) => (iso ? f.dateTime(iso) : t('library.meta.notSet'));
  const or = (v: ReactNode) => (v === null || v === '' ? t('library.meta.notSet') : v);

  return (
    <Sheet size="wide" title={t('library.meta.title')} onClose={onClose}>
      {failed ? (
        <p className="hint" role="alert">
          {t('library.meta.failed')}
        </p>
      ) : !data ? (
        <div className="spinner" role="status" aria-label={t('library.meta.loading')} />
      ) : (
        <div className="bookmeta">
          <section className="bookmeta__section" aria-labelledby="bm-disk">
            <h3 id="bm-disk" className="bookmeta__title">
              {t('library.meta.onDisk')}
            </h3>
            {!data.file.present && <p className="bookmeta__warn">{t('library.meta.missing')}</p>}
            <dl className="bookmeta__rows">
              <Row
                label={t(data.file.isFolder ? 'library.meta.folderName' : 'library.meta.fileName')}
              >
                <Path value={data.file.name} />
              </Row>
              <Row label={t('library.meta.location')}>
                {data.file.folder ? (
                  <Path value={data.file.folder} />
                ) : (
                  t('library.meta.libraryTop')
                )}
              </Row>
              <Row label={t('library.meta.library')}>
                <Path value={data.file.library} />
              </Row>
              <Row label={t('library.meta.fullPath')}>
                <Path value={data.file.path} />
                <button
                  type="button"
                  className="bookmeta__copy"
                  onClick={() => void copy(data.file.path)}
                  aria-label={t('library.meta.copyPath')}
                >
                  {t('library.meta.copy')}
                </button>
              </Row>
              <Row label={t('library.meta.format')}>
                {/* An audiobook in many files is "multi" to the database; say what its files are. */}
                {(data.file.format === 'multi' && data.tracks.length > 0
                  ? [...new Set(data.tracks.map((tr) => tr.format.toUpperCase()))].join(', ')
                  : data.file.format.toUpperCase()) + ` · ${f.bytes(data.file.sizeBytes)}`}
              </Row>
              <Row label={t('library.meta.modified')}>{when(data.file.modifiedAt)}</Row>
            </dl>
            {data.tracks.length > 0 && (
              <details className="bookmeta__tracks">
                <summary>{t('library.meta.tracks', { n: data.tracks.length })}</summary>
                <ol>
                  {data.tracks.map((tr, i) => (
                    <li key={i}>
                      <Path value={tr.name} />
                      <span className="bookmeta__aside">
                        {formatDuration(tr.durationMs)} · {f.bytes(tr.sizeBytes)}
                      </span>
                    </li>
                  ))}
                </ol>
              </details>
            )}
          </section>

          <section className="bookmeta__section" aria-labelledby="bm-file">
            <h3 id="bm-file" className="bookmeta__title">
              {t('library.meta.fromFile')}
            </h3>
            <dl className="bookmeta__rows">
              <Row label={t('library.meta.titleLabel')}>{data.embedded.title}</Row>
              <Row label={t('library.meta.author')}>{or(data.embedded.author)}</Row>
              <Row label={t('library.meta.series')}>
                {data.embedded.series
                  ? `${data.embedded.series}${
                      data.embedded.seriesIdx !== null
                        ? ` ${t('library.book.seriesIndex', { n: data.embedded.seriesIdx })}`
                        : ''
                    }`
                  : t('library.meta.notSet')}
              </Row>
              <Row label={t('library.meta.language')}>
                {data.embedded.language
                  ? `${f.languageName(data.embedded.language)} (${data.embedded.language})`
                  : t('library.meta.notSet')}
              </Row>
              <Row label={t('library.meta.publisher')}>{or(data.embedded.publisher)}</Row>
              <Row label={t('library.meta.identifiers')}>
                {Object.keys(data.embedded.identifiers).length === 0 ? (
                  t('library.meta.notSet')
                ) : (
                  <ul className="bookmeta__list">
                    {Object.entries(data.embedded.identifiers).map(([k, v]) => (
                      <li key={k}>
                        <span className="bookmeta__aside">{k}</span> <Path value={v} />
                      </li>
                    ))}
                  </ul>
                )}
              </Row>
              {groupTags(data.embedded.tags).map(([kind, values]) => (
                <Row key={kind} label={t('library.meta.tagKind', { kind })}>
                  {f.list(values)}
                </Row>
              ))}
            </dl>
          </section>

          <section className="bookmeta__section" aria-labelledby="bm-rp">
            <h3 id="bm-rp" className="bookmeta__title">
              {t('library.meta.inReadPort')}
            </h3>
            <dl className="bookmeta__rows">
              <Row label={t('library.meta.id')}>
                <Path value={data.readport.id} />
                <button
                  type="button"
                  className="bookmeta__copy"
                  onClick={() => void copy(data.readport.id)}
                  aria-label={t('library.meta.copyId')}
                >
                  {t('library.meta.copy')}
                </button>
              </Row>
              <Row label={t('library.meta.added')}>{when(data.readport.addedAt)}</Row>
              <Row label={t('library.meta.indexed')}>{when(data.readport.indexedAt)}</Row>
              <Row label={t('library.meta.state')}>
                {t('library.meta.stateValue', { state: data.readport.state })}
                {data.readport.error && (
                  <span className="bookmeta__error">{data.readport.error}</span>
                )}
              </Row>
              <Row label={t('library.meta.language')}>
                {data.readport.language.value
                  ? f.languageName(data.readport.language.value)
                  : t('library.meta.notSet')}
                {data.readport.language.source && (
                  <span className="bookmeta__aside">
                    {t('library.meta.languageSource', { source: data.readport.language.source })}
                  </span>
                )}
              </Row>
              <Row label={t('library.meta.cover')}>
                {data.readport.cover === 'own'
                  ? t('library.meta.coverOwn')
                  : data.readport.cover === 'picked'
                    ? data.readport.coverSource && data.readport.coverSource in COVER_SOURCE_NAME
                      ? t('library.meta.coverPicked', {
                          source:
                            COVER_SOURCE_NAME[
                              data.readport.coverSource as keyof typeof COVER_SOURCE_NAME
                            ],
                        })
                      : t('library.meta.coverPickedEdition')
                    : t('library.meta.coverNone')}
              </Row>
              <Row
                label={t(
                  data.readport.durationMs ? 'library.meta.duration' : 'library.meta.length',
                )}
              >
                {data.readport.durationMs
                  ? formatDuration(data.readport.durationMs)
                  : [
                      t('library.meta.chapters', { n: data.readport.chapters }),
                      data.readport.characters !== null
                        ? t('library.meta.characters', { n: data.readport.characters })
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
              </Row>
              {data.readport.pair && (
                <Row label={t('library.meta.pairedWith')}>
                  {data.readport.pair.title}
                  <span className="bookmeta__aside">
                    {t('library.meta.pairKind', { kind: data.readport.pair.kind })} ·{' '}
                    {t('library.meta.pairStatus', { status: data.readport.pair.status })}
                  </span>
                </Row>
              )}
              {data.readport.hidden && (
                <Row label={t('library.meta.hidden')}>
                  {data.readport.hidden.by
                    ? t('library.meta.hiddenBy', {
                        when: f.dateTime(data.readport.hidden.at),
                        name: data.readport.hidden.by,
                      })
                    : f.dateTime(data.readport.hidden.at)}
                </Row>
              )}
            </dl>
          </section>
        </div>
      )}
    </Sheet>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="bookmeta__row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** A path, a name on disk, an identifier: exact text, left to right in any interface. */
function Path({ value }: { value: string }) {
  return (
    <code className="bookmeta__path" dir="ltr">
      {value}
    </code>
  );
}

function groupTags(tags: BookMetadata['embedded']['tags']): [string, string[]][] {
  const out = new Map<string, string[]>();
  for (const tag of tags) out.set(tag.kind, [...(out.get(tag.kind) ?? []), tag.value]);
  return [...out.entries()];
}
