import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  BOOK_LANGUAGES,
  type RichBlock,
  type AudioLocator,
  type BookSummary,
  type EbookLocator,
} from '@readport/shared';
import { api, ApiError, failureMessage, isOffline } from '../api/client';
import { type Annotation, type BookDetail, type ResolveResponse } from '../lib/types';
import { EmptyState, Sheet, useToast } from '../components/ui';
import { AddToSheet } from '../components/AddToSheet';
import { HiddenMark } from '../components/HiddenMark';
import { BookFriendsRow } from './FriendsPage';
import { ShareMenu } from '../share/ShareMenu';
import { useShelves } from '../state/shelves';
import { useSession } from '../state/session';
import {
  IconAlert,
  IconBookmark,
  IconBookOpen,
  IconDownload,
  IconEye,
  IconEyeOff,
  IconInfo,
  IconHeadphones,
  IconLanguages,
  IconReadAlong,
  IconLink,
  IconClose,
  IconCloudCheck,
  IconLibrary,
  IconList,
  IconOffline,
  IconShelf,
  IconSwitch,
  IconTrash,
} from '../components/icons';
import { useT } from '../i18n';
import { useFormat } from '../i18n/useFormat';
import { type MessageKey } from '../i18n/messages/en';
import {
  cachedSwitch,
  cancelDownload,
  DownloadError,
  downloadErrorKey,
  downloadFraction,
  downloadPercent,
  getDownloadState,
  preparedFraction,
  removeDownload,
  startDownload,
  type DownloadState,
} from '../offline/downloads';
import { bookAudioSupport } from '../lib/audioSupport';
import { ambientColorFromImage } from '../lib/ambient';
import { coverSrc } from '../lib/cover';
import { recordCheckpoint } from '../progress/engine';
import { useDownloadState } from '../offline/useDownloads';
import { OtherLanguagesRow } from '../translations/OtherLanguagesRow';
import { RichText } from '../components/RichText';
import { CoverPicker } from '../components/CoverPicker';
import { BookMetadataSheet } from '../components/BookMetadataSheet';
import { LinkTranslationsSheet } from '../translations/LinkTranslationsSheet';
import { PairSheet } from '../components/PairSheet';

/** The paired edition, as far as the offline sheet needs to describe it. */
interface Companion {
  id: string;
  kind: 'ebook' | 'audio';
  sizeBytes: number;
}

export function BookPage() {
  const t = useT();
  const f = useFormat();
  const { id = '' } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [detail, setDetail] = useState<BookDetail | null>(null);
  const [error, setError] = useState<MessageKey | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  // Live: a download started here, in another tab or before a reload is
  // heard as it goes (offline/useDownloads.ts), not read once on arrival.
  const dl = useDownloadState(id) ?? null;
  const [companion, setCompanion] = useState<Companion | null>(null);
  // `undefined` until this device has been asked; null means never downloaded.

  const [ambient, setAmbient] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [offlineSheet, setOfflineSheet] = useState(false);
  const [addTo, setAddTo] = useState(false);
  /** The files to keep: both editions of a pair, or an audiobook's many files. */
  const [saveOpen, setSaveOpen] = useState(false);
  /** The other edition's detail, for its row in that sheet; null when it could not be read. */
  const [otherDetail, setOtherDetail] = useState<BookDetail | null | undefined>(undefined);
  const [hideSheet, setHideSheet] = useState(false);
  const [metaSheet, setMetaSheet] = useState(false);
  const [hiding, setHiding] = useState(false);
  /** The sheet a curator links this book to its other languages in. */
  const [languagesSheet, setLanguagesSheet] = useState(false);
  /** And the one they pair it with its other format in. */
  const [pairSheet, setPairSheet] = useState(false);
  const { user } = useSession();
  const canCurate = user?.role === 'admin' || user?.role === 'curator';
  const [member, setMember] = useState<{
    shelfIds: string[];
    onReadingList: boolean;
    readingListPosition: number | null;
  } | null>(null);
  const autoSwitched = useRef(false);
  const { overview, refresh: refreshShelves } = useShelves();

  const load = useCallback(async () => {
    try {
      const d = await api<BookDetail>(`/api/books/${id}`);
      setDetail(d);
      setError(null);
      const anns = await api<{ annotations: Annotation[] }>(`/api/books/${id}/annotations`).catch(
        () => ({ annotations: [] as Annotation[] }),
      );
      setAnnotations(anns.annotations);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        // Gone from the library, or hidden from this reader by an admin:
        // either way a copy kept on this device is not theirs to keep
        // reading, and it would sit there taking up room behind a book page
        // that will not open.
        await removeDownload(id).catch(() => {});
        setError('library.book.gone');
      } else {
        setError('library.book.loadFailed');
      }
    }
  }, [id]);

  const loadMembership = useCallback(async () => {
    try {
      setMember(
        await api<{
          shelfIds: string[];
          onReadingList: boolean;
          readingListPosition: number | null;
        }>(`/api/books/${id}/shelves`),
      );
    } catch {
      setMember(null);
    }
  }, [id]);

  useEffect(() => {
    void loadMembership();
  }, [loadMembership]);

  useEffect(() => {
    void load();
  }, [load]);

  // Whether the paired edition is on this device decides what the tandem
  // card may promise, so it is read (from local storage only) up front.
  const otherBookId = detail?.book.pair?.otherBookId ?? null;
  const companionDl = useDownloadState(otherBookId);

  useEffect(() => {
    if (!detail?.book.hasCover) return;
    let cancelled = false;
    ambientColorFromImage(coverSrc(detail.book)).then((c) => {
      if (!cancelled && c) setAmbient(c);
    });
    return () => {
      cancelled = true;
    };
  }, [detail, id]);

  /**
   * Open the other edition AT THE SAME PLACE: resolve this book's saved
   * position through the pair alignment and hand off with a marker. Falls
   * back to plainly opening the other edition (at its own position) when the
   * pair is not aligned or nothing has been read yet.
   *
   * `along` opens the EBOOK with the narration on the page instead - the
   * third way to take a paired book. From an ebook that is this book at its
   * own position; from an audiobook it is the same resolved handoff as a
   * switch, and the reader starts the voice once it has landed.
   */
  const openEdition = useCallback(
    async (along = false) => {
      if (!detail?.book.pair) return;
      const { pair, progress, kind } = detail.book;
      const alongQuery = along ? 'along=1' : '';
      if (along && kind === 'ebook') {
        navigate(`/read/${id}?${alongQuery}`);
        return;
      }
      const otherRoute =
        kind === 'ebook'
          ? `/listen/${pair.otherBookId}`
          : `/read/${pair.otherBookId}${along ? `?${alongQuery}` : ''}`;
      if (!pair.switchable || !progress || progress.pct <= 0.001) {
        navigate(otherRoute);
        return;
      }
      setSwitching(true);
      try {
        let res: ResolveResponse;
        try {
          res = await api<ResolveResponse>(`/api/pairs/${pair.pairId}/resolve`, {
            method: 'POST',
            body: { from: progress.locator },
          });
        } catch (err) {
          if (!isOffline(err)) throw err;
          // No network. The downloaded package carries the server's own
          // answers for this book, so the handoff lands where it would online.
          const stored = await cachedSwitch(id, progress.locator);
          if (!stored) {
            toast.show(t('library.book.switchNotStored'));
            navigate(otherRoute);
            return;
          }
          res = stored;
        }
        if (!res.to) {
          toast.show(res.resolution.reason ?? t('library.book.switchNoPosition'));
          navigate(otherRoute);
          return;
        }
        void recordCheckpoint(id, 'switch', progress.locator);
        if (res.to.medium === 'audio') {
          const to = res.to as AudioLocator;
          navigate(
            `/listen/${pair.otherBookId}?track=${to.trackIdx}&pos=${to.positionMs}&handoff=1&granularity=${res.resolution.granularity}`,
          );
        } else {
          const to = res.to as EbookLocator;
          navigate(
            `/read/${pair.otherBookId}?spine=${to.spineIdx}&char=${to.charOffset ?? 0}${
              to.sentenceId ? `&sentence=${to.sentenceId}` : ''
            }&handoff=1&granularity=${res.resolution.granularity}${along ? `&${alongQuery}` : ''}`,
          );
        }
      } catch {
        toast.show(t('library.book.switchFailed'));
        navigate(otherRoute);
      } finally {
        setSwitching(false);
      }
    },
    [detail, id, navigate, toast, t],
  );
  const openOtherEdition = useCallback(() => openEdition(false), [openEdition]);

  // `?switch=1` (from the library's "Listen/Read instead") switches right away.
  useEffect(() => {
    if (!detail || autoSwitched.current || searchParams.get('switch') !== '1') return;
    autoSwitched.current = true;
    void openOtherEdition();
  }, [detail, searchParams, openOtherEdition]);

  if (error) {
    return (
      <main className="app-main" id="main-content" tabIndex={-1}>
        <div className="banner banner--error" role="alert">
          <IconAlert size={18} /> {t(error)}
        </div>
      </main>
    );
  }
  if (!detail) {
    return (
      <main className="app-main" id="main-content" tabIndex={-1} aria-busy="true">
        <div className="book-hero">
          <div className="skeleton book-hero__cover" />
          <div style={{ flex: 1 }}>
            <div className="skeleton" style={{ height: 32, maxWidth: 360 }} />
            <div className="skeleton" style={{ height: 18, maxWidth: 200, marginTop: 12 }} />
          </div>
        </div>
      </main>
    );
  }

  const { book } = detail;
  const isEbook = book.kind === 'ebook';
  const pct = book.progress?.pct ?? 0;
  const pair = book.pair && book.pair.status !== 'candidate' ? book.pair : null;
  /**
   * The note under a paired book's buttons, when there is something to say.
   *
   * It used to be on every paired book - "You own the ebook too. Switching
   * lands close to where you are..." - under three buttons that already say
   * the book is owned both ways, and "close" is a claim about the aligner
   * nobody reading needs. It speaks now only when switching will not do
   * what the buttons promise: the pair is not timed yet, so the other
   * edition starts at the beginning, or this edition is on the device and
   * the other one is not, so switching needs a connection.
   */
  const pairUntimed = !!pair && (!pair.switchable || !pair.handoff);
  const pairOffline =
    !!pair && dl?.status === 'done' && companionDl !== undefined && companionDl?.status !== 'done';
  /**
   * Discovered but not yet indexed, and with nothing usable from a previous
   * pass. A scan inserts every book it finds up front and then indexes them a
   * couple at a time, so on a real library this state lasts the whole run -
   * and the grid already says "Indexing…" on the card while the detail page
   * offered a Read button that leads nowhere.
   */
  const notReadyYet =
    (book.scanState === 'discovered' || book.scanState === 'indexing') &&
    detail.chapters.length === 0 &&
    detail.tracks.length === 0;
  const audioSupport = isEbook
    ? null
    : bookAudioSupport(
        detail.tracks.length > 0 ? detail.tracks.map((t) => t.format) : [book.format],
      );

  /**
   * A paired title is two packages. Downloading them one after the other
   * (rather than in parallel) keeps the progress the sheet shows honest and
   * stops a large audiobook from starving the small ebook beside it.
   */
  const download = async (withCompanion: boolean) => {
    const wanted = [id, ...(withCompanion && companion ? [companion.id] : [])];
    const targets: string[] = [];
    for (const target of wanted) {
      if ((await getDownloadState(target))?.status !== 'done') targets.push(target);
    }
    try {
      toast.show(
        targets.length > 1 ? t('library.offline.startingBoth') : t('library.offline.starting'),
      );
      for (const target of targets) {
        await startDownload(target, () => {}, { title: book.title });
        const state = await getDownloadState(target);
        if (state?.status === 'done') continue;
        if (state?.status === 'cancelled') toast.show(t('library.download.stopped'));
        else toast.show(t(downloadErrorKey(state?.errorCode)));
        return;
      }
      toast.show(
        wanted.length > 1 ? t('library.download.doneBoth') : t('library.download.available'),
      );
    } catch (err) {
      toast.show(
        err instanceof DownloadError && err.code === 'no-cache-storage'
          ? t('library.download.needsHttps', { app: t('common.appName') })
          : failureMessage(err, t('library.download.failed'), t),
      );
    }
  };

  /**
   * The paired edition's size is not part of this book's detail, and the
   * sheet must quote it before the user commits - so it is fetched when the
   * sheet opens. Offline the fetch fails and the sheet simply says the
   * edition is not on this device without a number.
   */
  const openOfflineSheet = async () => {
    setOfflineSheet(true);
    const other = book.pair?.otherBookId;
    if (!other || companion?.id === other) return;
    try {
      const d = await api<BookDetail>(`/api/books/${other}`);
      setCompanion({ id: other, kind: d.book.kind, sizeBytes: d.book.sizeBytes });
    } catch {
      // Offline: the edition still exists and still needs downloading, so
      // say so without a size rather than pretending there is nothing else.
      setCompanion({ id: other, kind: isEbook ? 'audio' : 'ebook', sizeBytes: 0 });
    }
  };

  /**
   * Hide the book from everyone but the admins, or show it again. The server
   * moves both editions of a title owned twice together and answers with
   * this book as it now is.
   */
  const setVisibility = async (hidden: boolean) => {
    setHiding(true);
    try {
      const res = await api<{ book: BookSummary }>(`/api/books/${id}/hidden`, {
        method: 'POST',
        body: { hidden },
      });
      setDetail((d) => (d ? { ...d, book: res.book } : d));
      setHideSheet(false);
      toast.show(hidden ? t('library.hidden.done') : t('library.hidden.shown'));
      void refreshShelves();
    } catch (err) {
      toast.show(failureMessage(err, t('library.hidden.failed'), t));
    } finally {
      setHiding(false);
    }
  };

  return (
    <main
      className="app-main book-page"
      id="main-content"
      tabIndex={-1}
      style={ambient ? ({ '--pl-ambient': ambient } as React.CSSProperties) : undefined}
    >
      <div className="book-hero__backdrop" aria-hidden="true" />
      <div className="book-hero">
        <CoverPicker
          book={book}
          canCurate={canCurate}
          onChanged={(changed) => {
            setDetail((d) => (d ? { ...d, book: changed } : d));
            void refreshShelves();
          }}
        >
          {book.hidden && <HiddenMark />}
        </CoverPicker>
        <div className="book-hero__body">
          <div className="book-hero__eyebrow">
            {isEbook ? <IconBookOpen size={14} /> : <IconHeadphones size={14} />}
            {isEbook ? t('common.ebook') : t('common.audiobook')}
            {book.series && (
              <>
                {' · '}
                {book.series}
                {book.seriesIdx ? ` ${t('library.book.seriesIndex', { n: book.seriesIdx })}` : ''}
              </>
            )}
          </div>
          <h1>{book.title}</h1>
          {book.author && <div className="book-hero__author">{book.author}</div>}
          <div className="book-hero__meta">
            <span>{isEbook ? 'EPUB' : book.format.toUpperCase()}</span>
            <LanguageChip
              book={book}
              canEdit={user?.role === 'admin' || user?.role === 'curator'}
              onChanged={() => void load()}
            />
            {!isEbook && book.durationMs != null && <span>{f.duration(book.durationMs)}</span>}
            {detail.chapters.length > 0 && (
              <span>{t('library.book.chapters', { n: detail.chapters.length })}</span>
            )}
            <span>{f.bytes(book.sizeBytes)}</span>
          </div>
          <OtherLanguagesRow titles={detail.translations ?? []} />
          {book.hidden && (
            // Only an admin is ever shown a hidden book, so this is always
            // the person who can undo it - and the undo sits in the note
            // that explains it, not in the tools row below.
            <div className="hidden-note" role="note">
              <IconEyeOff size={18} className="hidden-note__icon" />
              <p className="hidden-note__text">
                <strong>{t('library.hidden.noteTitle')}</strong>
                <span>
                  {book.hidden.by
                    ? t('library.hidden.noteBy', {
                        name: book.hidden.by,
                        when: f.ago(book.hidden.at),
                      })
                    : t('library.hidden.noteWhen', { when: f.ago(book.hidden.at) })}
                </span>
              </p>
              <button
                type="button"
                className="btn btn--secondary hidden-note__show"
                disabled={hiding}
                onClick={() => void setVisibility(false)}
              >
                <IconEye size={16} /> {t('library.hidden.show')}
              </button>
            </div>
          )}
          {audioSupport && !audioSupport.supported && audioSupport.reason && (
            <div className="banner" role="note">
              <IconAlert size={16} /> {t(audioSupport.reason, { format: audioSupport.format })}
            </div>
          )}
          {book.scanState === 'error' && (
            <div className="banner banner--error" role="alert">
              <IconAlert size={16} /> {t('library.book.indexingFailed')} <bdi>{book.scanError}</bdi>
            </div>
          )}
          {notReadyYet && (
            <div className="banner" role="status">
              <IconAlert size={16} />{' '}
              {t('library.book.stillIndexing', { app: t('common.appName') })}
            </div>
          )}
          {book.scanState === 'missing' && (
            <div className="banner banner--error" role="alert">
              <IconAlert size={16} /> {t('library.book.filesMissing')}
            </div>
          )}
          {book.progress && pct > 0.001 && (
            <div className="book-hero__progress">
              <span className="progressbar" aria-hidden="true">
                <span style={{ width: `${pct * 100}%` }} />
              </span>
              <span>
                {book.progress.finished
                  ? t('library.card.finished')
                  : t('library.book.progress', { pct: f.percent(pct), kind: book.kind })}
                {!isEbook && !book.progress.finished && book.durationMs
                  ? ` · ${t('format.left', { duration: f.duration(book.durationMs * (1 - pct)) })}`
                  : ''}
              </span>
            </div>
          )}
          <div className="book-hero__actions">
            {notReadyYet ? (
              // Opening one of these lands on "Cannot open book" for an ebook,
              // or on a player with no audio at all - a dead end whose only
              // exit is back to a page that looks perfectly healthy.
              <button className="btn" disabled title={t('library.book.stillIndexedTitle')}>
                {isEbook ? <IconBookOpen size={18} /> : <IconHeadphones size={18} />}{' '}
                {t('library.card.indexing')}
              </button>
            ) : isEbook ? (
              <Link className="btn" to={`/read/${book.id}`}>
                <IconBookOpen size={18} /> {t('library.book.open', { kind: book.kind })}
              </Link>
            ) : audioSupport && !audioSupport.supported ? (
              <button
                className="btn"
                disabled
                title={
                  audioSupport.reason
                    ? t(audioSupport.reason, { format: audioSupport.format })
                    : undefined
                }
              >
                <IconHeadphones size={18} /> {t('library.book.open', { kind: book.kind })}
              </button>
            ) : (
              <Link className="btn" to={`/listen/${book.id}`}>
                <IconHeadphones size={18} /> {t('library.book.open', { kind: book.kind })}
              </Link>
            )}
            {pair && (
              // Owning the book both ways gives three ways to take it, and
              // they are three buttons rather than one with a menu hidden in
              // it: Read, Listen, and - between them, because it is both -
              // Read along, the page with the voice on it. The same three in
              // the same order whichever edition this page is, so the middle
              // one is always the bridge. Read along needs the alignment,
              // so until the pair has it the button says so instead of
              // opening a page the voice cannot follow.
              <>
                <button
                  className="btn btn--secondary"
                  onClick={() => void openEdition(true)}
                  disabled={switching || !pair.switchable}
                  title={
                    pair.switchable
                      ? t('library.book.readAlongHint')
                      : t('library.book.readAlongNotReady')
                  }
                >
                  <IconReadAlong size={17} />
                  {switching ? t('library.book.opening') : t('library.book.readAlong')}
                </button>
                <button
                  className="btn btn--secondary"
                  onClick={() => void openOtherEdition()}
                  disabled={switching}
                >
                  {isEbook ? <IconHeadphones size={17} /> : <IconBookOpen size={17} />}
                  {switching
                    ? t('library.book.opening')
                    : t('library.book.openOther', { kind: book.kind })}
                </button>
              </>
            )}
          </div>
          {/* Keeping, sharing and saving: a quieter row than the ways to
              open the book, and one line on a desk. */}
          <div className="book-hero__tools">
            <button className="btn btn--ghost book-tool" onClick={() => setAddTo(true)}>
              <IconShelf size={17} />
              <span>{t('library.card.addTo')}</span>
            </button>
            <OfflineButton dl={dl} onClick={() => void openOfflineSheet()} />
            {/* A link to a hidden book would open on nothing for everybody
                it was sent to, so a hidden book has none to give. */}
            {!book.hidden && <ShareMenu bookId={id} title={book.title} />}
            {user?.canExport &&
              !notReadyYet &&
              // Distinct from Save offline beside it, which keeps the book
              // inside the app and can be removed again - this hands over
              // the book's own files, which leave with the reader. "Save a
              // copy" and "Download" beside each other read as the same
              // thing twice; "Save offline" and "Download file" do not.
              (pair || (!isEbook && detail.tracks.length > 1) ? (
                // Two editions, or an audiobook in many files: a choice,
                // so a sheet.
                <button
                  type="button"
                  className="btn btn--ghost book-tool"
                  title={t('library.book.downloadFileHint')}
                  onClick={() => {
                    setSaveOpen(true);
                    if (pair && otherDetail === undefined) {
                      api<BookDetail>(`/api/books/${pair.otherBookId}`)
                        .then(setOtherDetail)
                        .catch(() => setOtherDetail(null));
                    }
                  }}
                >
                  <IconDownload size={17} />
                  <span>{t('library.book.downloadFiles')}</span>
                </button>
              ) : (
                // One file: a real link, because the browser has to perform
                // the save itself.
                <a
                  className="btn btn--ghost book-tool"
                  title={t('library.book.downloadFileHint')}
                  href={`/api/books/${book.id}/export`}
                  download=""
                >
                  <IconDownload size={17} />
                  <span>{t('library.book.downloadFile')}</span>
                </a>
              ))}
            {canCurate && (
              <button
                type="button"
                className="btn btn--ghost book-tool"
                title={t('library.pairing.toolHint', { kind: book.kind })}
                onClick={() => setPairSheet(true)}
              >
                <IconLink size={17} />
                <span>{t('library.pairing.tool')}</span>
              </button>
            )}
            {canCurate && (
              <button
                type="button"
                className="btn btn--ghost book-tool"
                title={t('translations.toolHint')}
                onClick={() => setLanguagesSheet(true)}
              >
                <IconLanguages size={17} />
                <span>{t('translations.tool')}</span>
              </button>
            )}
            {user?.role === 'admin' && !book.hidden && (
              <button
                type="button"
                className="btn btn--ghost book-tool"
                title={t('library.hidden.toolHint')}
                onClick={() => setHideSheet(true)}
              >
                <IconEyeOff size={17} />
                <span>{t('library.hidden.tool')}</span>
              </button>
            )}
            {user?.role === 'admin' && (
              <button
                type="button"
                className="btn btn--ghost book-tool"
                title={t('library.meta.toolHint')}
                onClick={() => setMetaSheet(true)}
              >
                <IconInfo size={17} />
                <span>{t('library.meta.tool')}</span>
              </button>
            )}
          </div>
          {(pairUntimed || pairOffline) && (
            // One quiet line, not a card, and only when switching will not
            // do what the buttons promise.
            <p className="book-hero__pairnote">
              <IconSwitch size={14} />
              <span>
                {pairUntimed &&
                  `${t('library.pair.switchUnaligned', { kind: isEbook ? 'ebook' : 'audio' })} `}
                {pairOffline && `${t('library.book.otherNotOnDevice', { kind: book.kind })} `}
                {pairUntimed && <Link to="/pairs">{t('library.book.reviewPairing')}</Link>}
              </span>
            </p>
          )}
          <MembershipChips
            member={member}
            shelfNames={new Map((overview?.shelves ?? []).map((s) => [s.id, s.name]))}
            onRemoveShelf={(shelfId, name) =>
              void (async () => {
                await api(`/api/shelves/${shelfId}/books/${id}`, { method: 'DELETE' }).catch(
                  () => {},
                );
                await loadMembership();
                await refreshShelves();
                toast.show(t('library.book.takenOffShelf', { name }));
              })()
            }
            onRemoveQueue={() =>
              void (async () => {
                await api(`/api/reading-list/${id}`, { method: 'DELETE' }).catch(() => {});
                await loadMembership();
                await refreshShelves();
                toast.show(t('library.queue.takenOff'));
              })()
            }
          />
        </div>
      </div>

      {/* Where friends are in this book, when there are friends at all. */}
      <BookFriendsRow
        book={book}
        canRecommend={!book.hidden}
        translations={detail.translations ?? []}
      />

      {book.pair && book.pair.status === 'candidate' && (
        <div className="banner" role="note">
          <IconLink size={16} />
          <span style={{ flex: 1 }}>{t('library.book.candidateFound', { kind: book.kind })}</span>
          {/* Decided here, beside the book, by someone who can decide. */}
          {canCurate ? (
            <button
              type="button"
              className="btn btn--ghost"
              style={{ minHeight: 36 }}
              onClick={() => setPairSheet(true)}
            >
              {t('library.book.review')}
            </button>
          ) : (
            <Link to="/pairs" className="btn btn--ghost" style={{ minHeight: 36 }}>
              {t('library.book.review')}
            </Link>
          )}
        </div>
      )}

      {detail.chapters.length > 0 && (
        <section className="list-card" aria-label={t('library.book.chaptersLabel')}>
          <div className="list-card__head">
            {t('library.book.chaptersHead', { n: detail.chapters.length })}
          </div>
          {detail.chapters.map((c, i) => (
            <button
              key={c.idx}
              className="list-row"
              onClick={() =>
                isEbook
                  ? navigate(`/read/${book.id}?spine=${c.spineIdx ?? 0}`)
                  : navigate(`/listen/${book.id}?pos=${c.startMs ?? 0}`)
              }
            >
              <span className="soft" style={{ width: 24, textAlign: 'end' }}>
                {f.number(i + 1)}
              </span>
              <span className="grow">{c.title}</span>
              {c.startMs != null && (
                <span className="soft">
                  {c.endMs != null ? f.duration(c.endMs - c.startMs) : f.duration(c.startMs)}
                </span>
              )}
            </button>
          ))}
        </section>
      )}

      {annotations.length > 0 && (
        <section className="list-card" aria-label={t('library.book.annotationsLabel')}>
          <div className="list-card__head">
            {t('library.book.annotationsHead', { n: annotations.length })}
          </div>
          {annotations.map((a) => (
            <button
              key={a.id}
              className="list-row"
              onClick={() => {
                if (a.locator.medium === 'ebook') {
                  navigate(
                    `/read/${book.id}?spine=${a.locator.spineIdx}&char=${a.locator.charOffset ?? 0}`,
                  );
                } else {
                  navigate(
                    `/listen/${book.id}?track=${a.locator.trackIdx}&pos=${a.locator.positionMs}`,
                  );
                }
              }}
            >
              <IconBookmark size={16} filled={a.kind === 'bookmark'} />
              <span className="grow" style={{ whiteSpace: 'normal' }}>
                {a.selectedText ?? a.note ?? t('library.book.annotationKind', { kind: a.kind })}
                {a.note && a.selectedText && (
                  <span style={{ display: 'block', fontSize: 13, color: 'var(--rp-text-soft)' }}>
                    {a.note}
                  </span>
                )}
              </span>
              <span className="soft">{f.percent(a.locator.pct)}</span>
            </button>
          ))}
        </section>
      )}

      {(detail.about?.length || detail.description) && (
        <section className="about" style={{ maxWidth: '65ch' }}>
          <h2 className="section-title">{t('library.book.about')}</h2>
          <About about={detail.about ?? null} description={detail.description} />
        </section>
      )}
      {detail.chapters.length === 0 && annotations.length === 0 && !detail.description && (
        <EmptyState title={t('library.book.noChaptersTitle')}>
          {t('library.book.noChaptersBody', { kind: book.kind })}
        </EmptyState>
      )}
      {offlineSheet && (
        <OfflineSheet
          book={{ title: book.title, kind: book.kind, sizeBytes: book.sizeBytes }}
          dl={dl}
          companion={book.pair ? companion : null}
          companionDl={book.pair ? (companionDl ?? null) : null}
          onClose={() => setOfflineSheet(false)}
          onDownload={(withCompanion) => {
            setOfflineSheet(false);
            void download(withCompanion);
          }}
          onCancel={() => {
            cancelDownload(id);
            setOfflineSheet(false);
          }}
          onRemove={async () => {
            await removeDownload(id);
            setOfflineSheet(false);
            toast.show(t('library.download.removed'));
          }}
        />
      )}
      {languagesSheet && (
        <LinkTranslationsSheet
          book={book}
          onChanged={(titles) => setDetail((d) => (d ? { ...d, translations: titles } : d))}
          onClose={() => setLanguagesSheet(false)}
        />
      )}
      {metaSheet && <BookMetadataSheet bookId={book.id} onClose={() => setMetaSheet(false)} />}
      {pairSheet && (
        <PairSheet
          book={book}
          onChanged={() => {
            void load();
            void refreshShelves();
          }}
          onClose={() => setPairSheet(false)}
        />
      )}
      {hideSheet && (
        <Sheet
          size="narrow"
          title={t('library.hidden.askTitle')}
          onClose={() => setHideSheet(false)}
        >
          <p className="sheet__lede">{t('library.hidden.askLede', { title: book.title })}</p>
          {/* What hiding does, in the three places a reader would notice. */}
          <ul className="hide-points">
            <li>
              <IconLibrary size={17} />
              <span>{t('library.hidden.askShelves')}</span>
            </li>
            <li>
              <IconLink size={17} />
              <span>{t('library.hidden.askLinks')}</span>
            </li>
            <li>
              <IconBookmark size={17} />
              <span>{t('library.hidden.askKept')}</span>
            </li>
          </ul>
          {pair && <p className="hint">{t('library.hidden.askPair')}</p>}
          <div className="sheet__actions">
            <button className="btn" disabled={hiding} onClick={() => void setVisibility(true)}>
              <IconEyeOff size={16} /> {t('library.hidden.confirm')}
            </button>
            <button className="btn btn--ghost" onClick={() => setHideSheet(false)}>
              {t('common.cancel')}
            </button>
          </div>
        </Sheet>
      )}
      {addTo && (
        <AddToSheet
          bookId={id}
          title={book.title}
          onClose={() => setAddTo(false)}
          onChanged={() => void loadMembership()}
        />
      )}
      {saveOpen && (
        <DownloadSheet
          editions={[detail, ...(pair && otherDetail ? [otherDetail] : [])]}
          loadingOther={!!pair && otherDetail === undefined}
          onClose={() => setSaveOpen(false)}
        />
      )}
    </main>
  );
}

/**
 * The book's own files, to keep: each edition once, the ebook first.
 *
 * An audiobook in many files comes as one ZIP of all of them, in a folder
 * named for the book, because forty separate downloads is not a way to
 * take a book home. The files one at a time are still there underneath,
 * for the reader who wants only the part they are missing.
 */
function DownloadSheet({
  editions,
  loadingOther,
  onClose,
}: {
  editions: BookDetail[];
  /** The other edition of a pair is still being looked up. */
  loadingOther: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const f = useFormat();
  const sorted = [...editions]
    .filter((d) => d.book.scanState !== 'missing')
    .sort((a, b) => Number(a.book.kind === 'audio') - Number(b.book.kind === 'audio'));
  const audio = sorted.find((d) => d.book.kind === 'audio' && d.tracks.length > 1) ?? null;
  return (
    <Sheet title={t('library.book.downloadFilesTitle')} onClose={onClose}>
      <p className="sheet__lede">{t('library.book.downloadFilesLede')}</p>
      <div className="dl-list">
        {sorted.map((d) => {
          const { book } = d;
          const isEbook = book.kind === 'ebook';
          const many = !isEbook && d.tracks.length > 1;
          const size = f.bytes(
            d.tracks.length > 0 ? d.tracks.reduce((a, x) => a + x.sizeBytes, 0) : book.sizeBytes,
          );
          return (
            <a
              key={book.id}
              className="dl-row"
              href={many ? `/api/books/${book.id}/archive` : `/api/books/${book.id}/export`}
              download=""
            >
              <span className="dl-row__icon" aria-hidden="true">
                {isEbook ? <IconBookOpen size={20} /> : <IconHeadphones size={20} />}
              </span>
              <span className="dl-row__text">
                <strong>{isEbook ? t('common.ebook') : t('common.audiobook')}</strong>
                <span>
                  {many
                    ? t('library.book.downloadZip', { n: d.tracks.length, size })
                    : `${(isEbook ? 'EPUB' : book.format).toUpperCase()} · ${size}`}
                </span>
              </span>
              <IconDownload size={18} className="dl-row__go" />
            </a>
          );
        })}
        {loadingOther && <div className="skeleton dl-row dl-row--loading" aria-hidden="true" />}
      </div>
      {audio && (
        <details className="dl-parts">
          <summary>{t('library.book.downloadParts', { n: audio.tracks.length })}</summary>
          {audio.tracks.map((track, i) => (
            <a
              key={i}
              className="list-row"
              href={`/api/books/${audio.book.id}/export?track=${i}`}
              download=""
            >
              <IconDownload size={16} />
              <span className="grow">{track.title || t('library.book.part', { n: i + 1 })}</span>
              <span className="soft">
                {track.format.toUpperCase()} · {f.bytes(track.sizeBytes)}
              </span>
            </a>
          ))}
        </details>
      )}
    </Sheet>
  );
}

/**
 * Where this book already sits. Removing is one click from here, which is
 * the point: the panel is for adding, the chips are for undoing.
 */
function MembershipChips({
  member,
  shelfNames,
  onRemoveShelf,
  onRemoveQueue,
}: {
  member: { shelfIds: string[]; onReadingList: boolean; readingListPosition: number | null } | null;
  shelfNames: Map<string, string>;
  onRemoveShelf: (shelfId: string, name: string) => void;
  onRemoveQueue: () => void;
}) {
  const t = useT();
  const f = useFormat();
  if (!member || (member.shelfIds.length === 0 && !member.onReadingList)) return null;
  return (
    <div className="membership" role="group" aria-label={t('library.book.membershipLabel')}>
      {member.onReadingList && (
        <span className="membership__chip">
          <IconList size={13} />
          {t('shelves.readingList')}
          {member.readingListPosition ? ` · ${f.ordinal(member.readingListPosition)}` : ''}
          <button
            className="membership__x"
            aria-label={t('library.book.takeOffQueue')}
            onClick={onRemoveQueue}
          >
            <IconClose size={13} />
          </button>
        </span>
      )}
      {member.shelfIds.map((sid) => {
        const name = shelfNames.get(sid);
        if (!name) return null;
        return (
          <span className="membership__chip" key={sid}>
            <IconShelf size={13} />
            {name}
            <button
              className="membership__x"
              aria-label={t('library.book.takeOffShelf', { name })}
              onClick={() => onRemoveShelf(sid, name)}
            >
              <IconClose size={13} />
            </button>
          </span>
        );
      })}
    </div>
  );
}

/**
 * The one entry point to the offline copy, so it carries a visible word - an
 * icon alone has no tooltip on touch, which is where most reading and most
 * flights happen. "Save offline", with the cloud the On this device shelf
 * wears, so it never reads as the file download beside it.
 */
function OfflineButton({ dl, onClick }: { dl: DownloadState | null; onClick: () => void }) {
  const t = useT();
  const f = useFormat();
  const downloading = dl?.status === 'downloading';
  const done = dl?.status === 'done';
  const failed = dl?.status === 'error';
  // While the server prepares a big audiobook the ring shows that instead:
  // the one stretch where nothing arrives, and it used to look like nothing
  // was happening at all.
  const preparing = downloading && dl.phase === 'preparing';
  const pctDone = !downloading
    ? 0
    : preparing
      ? Math.round(preparedFraction(dl) * 100)
      : downloadPercent(dl);
  return (
    <button
      className={`btn btn--ghost book-tool offline-btn ${done ? 'is-done' : ''} ${downloading ? 'is-busy' : ''}`}
      onClick={onClick}
      aria-label={
        done
          ? t('library.offline.savedManage')
          : downloading
            ? t('library.offline.savingPct', { pct: f.percent(pctDone / 100) })
            : failed
              ? t('library.offline.retryLabel')
              : t('library.offline.saveLabel')
      }
    >
      {downloading ? (
        <span className="offline-btn__ring" style={{ '--pct': pctDone } as React.CSSProperties}>
          <span className="offline-btn__pct">{f.number(pctDone)}</span>
        </span>
      ) : done ? (
        <IconCloudCheck size={18} />
      ) : failed ? (
        <IconAlert size={18} />
      ) : (
        <IconOffline size={18} />
      )}
      {downloading ? (
        <span className="offline-btn__label">
          {preparing ? t('library.offline.preparing') : t('library.offline.saving')}
          {!preparing && dl.estimatedBytes > 0 && (
            <span className="offline-btn__bytes">
              {t('library.download.bytesOf', {
                stored: f.bytes(dl.storedBytes + (dl.receivingBytes ?? 0)),
                total: f.bytes(dl.estimatedBytes),
              })}
            </span>
          )}
        </span>
      ) : done ? (
        t('library.offline.saved')
      ) : failed ? (
        t('common.retry')
      ) : (
        t('library.offline.save')
      )}
    </button>
  );
}

/**
 * One sheet for the whole offline lifecycle: explain + confirm the download,
 * show progress with a cancel, or offer removal - of a finished copy or of
 * whatever a stopped attempt left behind.
 */
function OfflineSheet({
  book,
  dl,
  companion,
  companionDl,
  onClose,
  onDownload,
  onCancel,
  onRemove,
}: {
  book: { title: string; kind: 'ebook' | 'audio'; sizeBytes: number };
  dl: DownloadState | null;
  companion: Companion | null;
  companionDl: DownloadState | null;
  onClose: () => void;
  onDownload: (withCompanion: boolean) => void;
  onCancel: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  const f = useFormat();
  const downloading = dl?.status === 'downloading';
  const done = dl?.status === 'done';
  const kind = book.kind;
  const companionStored = companionDl?.status === 'done';
  const companionSize = {
    hasSize: !!companion && companion.sizeBytes > 0,
    size: companion ? f.bytes(companion.sizeBytes) : '',
  };
  // Bytes a stopped or failed attempt left on the device. They are reused by
  // the next attempt, but until then they are silent occupied space.
  const partialBytes = dl && !done && !downloading ? dl.storedBytes : 0;
  // A download under way: what it is doing, when there is more to say than
  // the numbers, and the numbers.
  const preparing = downloading && dl.phase === 'preparing';
  const progressFraction = !downloading
    ? 0
    : preparing
      ? preparedFraction(dl)
      : downloadFraction(dl);
  const progressStatus = !downloading
    ? null
    : preparing
      ? t('library.offline.preparingLede', {
          title: book.title,
          pct: f.percent(progressFraction),
        })
      : dl.phase === 'checking'
        ? t('library.offline.checking')
        : dl.phase === 'waiting'
          ? t('library.offline.waiting')
          : dl.phase === 'retrying'
            ? t('library.offline.retrying')
            : null;
  const progressNumbers =
    downloading && !preparing && dl.estimatedBytes > 0
      ? t('library.offline.progress', {
          stored: f.bytes(dl.storedBytes + (dl.receivingBytes ?? 0)),
          total: f.bytes(dl.estimatedBytes),
          pct: f.percent(progressFraction),
        })
      : null;
  return (
    <Sheet
      size="narrow"
      title={
        done
          ? t('library.download.available')
          : downloading
            ? t('library.offline.saving')
            : t('library.offline.askTitle')
      }
      onClose={onClose}
    >
      {done ? (
        <>
          <p className="sheet__lede">
            {t('library.download.storedLede', {
              title: book.title,
              bytes: f.bytes(dl.storedBytes),
              kind,
            })}
          </p>
          {companion && !companionStored && (
            <div className="banner" role="note">
              <IconAlert size={15} />
              <span style={{ flex: 1 }}>
                {t('library.download.companionMissing', { kind, ...companionSize })}
              </span>
            </div>
          )}
          <div className="sheet__actions">
            {companion && !companionStored && (
              <button className="btn" onClick={() => onDownload(true)}>
                <IconOffline size={16} /> {t('library.download.addOther', { kind })}
              </button>
            )}
            <button className="btn btn--danger" onClick={onRemove}>
              <IconTrash size={16} /> {t('library.download.remove')}
            </button>
            <button className="btn btn--secondary" onClick={onClose}>
              {t('library.download.keep')}
            </button>
          </div>
        </>
      ) : downloading ? (
        <>
          {progressStatus && <p className="sheet__lede">{progressStatus}</p>}
          {/* Bytes, not files: a single-file audiobook sat at a quarter for
              the whole download and then jumped to the end. */}
          <span className="progressbar" aria-hidden="true" style={{ height: 6 }}>
            <span style={{ width: `${progressFraction * 100}%` }} />
          </span>
          {progressNumbers && (
            <p className="dl-progress" role="status">
              {progressNumbers}
            </p>
          )}
          <p className="hint">{t('library.offline.keepOpen', { app: t('common.appName') })}</p>
          <div className="sheet__actions">
            <button className="btn btn--secondary" onClick={onCancel}>
              {t('library.download.cancel')}
            </button>
            <button className="btn btn--ghost" onClick={onClose}>
              {t('common.close')}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="sheet__lede">
            {t('library.download.askLede', {
              title: book.title,
              bytes: f.bytes(book.sizeBytes),
              kind,
            })}
          </p>
          {companion && !companionStored && (
            <p className="sheet__lede">
              {t('library.download.companionSeparate', { kind, ...companionSize })}
            </p>
          )}
          {partialBytes > 0 && (
            <p className="sheet__lede">
              {t('library.download.partialLede', { bytes: f.bytes(partialBytes) })}
            </p>
          )}
          {dl?.status === 'error' && (
            <div className="banner banner--error" role="alert">
              <IconAlert size={15} />
              <span>
                {t('library.download.interruptedLede')}
                {dl.errorCode ? (
                  <small className="hint"> {t(downloadErrorKey(dl.errorCode))}</small>
                ) : (
                  dl.error && (
                    <small className="hint">
                      {' '}
                      <bdi>{dl.error}</bdi>
                    </small>
                  )
                )}
              </span>
            </div>
          )}
          <div className="sheet__actions">
            {companion && !companionStored ? (
              <>
                <button className="btn" onClick={() => onDownload(true)}>
                  <IconOffline size={16} />{' '}
                  {t('library.offline.saveBoth', {
                    hasSize: companion.sizeBytes > 0,
                    size: f.bytes(book.sizeBytes + companion.sizeBytes),
                  })}
                </button>
                <button className="btn btn--secondary" onClick={() => onDownload(false)}>
                  {t('library.download.onlyThis', { kind, size: f.bytes(book.sizeBytes) })}
                </button>
              </>
            ) : (
              <button className="btn" onClick={() => onDownload(false)}>
                <IconOffline size={16} />{' '}
                {dl?.status === 'error' ? t('library.download.retry') : t('library.offline.save')}
              </button>
            )}
            {partialBytes > 0 && (
              <button className="btn btn--danger" onClick={onRemove}>
                <IconTrash size={16} /> {t('library.download.removePartial')}
              </button>
            )}
            <button className="btn btn--ghost" onClick={onClose}>
              {t('library.download.notNow')}
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}

/**
 * The book's language, where it came from, and - for a curator - a way to
 * say otherwise. A rescan cannot undo what is set here; the file's own tag,
 * a verified pair and the prose all rank below it.
 */
/** Past this height a description folds away behind More, so the chapters stay in reach. */
const ABOUT_FOLD_EM = 15;

/**
 * A book's description: laid out from the HTML or Markdown its file carried
 * (see components/RichText), or as it came from a server too old to lay it
 * out. A long one is folded to its first lines with More beneath; the fold
 * is measured, so a short description never offers a More that shows
 * nothing.
 */
function About({ about, description }: { about: RichBlock[] | null; description: string | null }) {
  const t = useT();
  const body = useRef<HTMLDivElement | null>(null);
  const [long, setLong] = useState(false);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    const measure = () => {
      const em = parseFloat(getComputedStyle(el).fontSize) || 16;
      setLong(el.scrollHeight > em * ABOUT_FOLD_EM * 1.2);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [about, description]);
  return (
    <>
      <div
        ref={body}
        id="about-body"
        className={`about__body${long && !open ? ' is-folded' : ''}`}
        style={{ '--about-fold': `${ABOUT_FOLD_EM}em` } as React.CSSProperties}
      >
        {about ? <RichText blocks={about} /> : <p>{description}</p>}
      </div>
      {long && (
        <button
          type="button"
          className="btn btn--ghost btn--sm about__more"
          aria-expanded={open}
          aria-controls="about-body"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? t('library.book.aboutLess') : t('library.book.aboutMore')}
        </button>
      )}
    </>
  );
}

function LanguageChip({
  book,
  canEdit,
  onChanged,
}: {
  book: BookSummary;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const t = useT();
  const f = useFormat();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const source = book.languageSource ?? null;
  const title = book.language
    ? t('library.book.languageTitle', { source: source ?? 'metadata' })
    : t('library.book.languageUnknown');
  if (!canEdit) {
    return (
      <span title={title}>
        {book.language ? f.languageName(book.language) : t('library.book.languageUnknown')}
      </span>
    );
  }
  return (
    <label className="lang-pick" title={title}>
      <span className="visually-hidden">{t('library.book.language')}</span>
      <select
        className="lang-pick__select"
        disabled={busy}
        value={source === 'manual' ? (book.language ?? '') : ''}
        onChange={async (ev) => {
          const language = ev.target.value || null;
          setBusy(true);
          try {
            await api(`/api/books/${book.id}/language`, { method: 'POST', body: { language } });
            toast.show(
              language
                ? t('library.book.languageSet', { name: f.languageName(language) })
                : t('library.book.languageAuto'),
            );
            onChanged();
          } catch (err) {
            toast.show(failureMessage(err, t('library.book.languageFailed'), t));
          } finally {
            setBusy(false);
          }
        }}
      >
        <option value="">
          {/* The language alone: where it came from - the file, the
              paired edition, the text itself - is the chip's tooltip, and
              "English · read from the text" said it on every book. */}
          {source === 'manual'
            ? t('library.book.languageAutoOption')
            : book.language
              ? f.languageName(book.language)
              : t('library.book.languageUnknownSet')}
        </option>
        {BOOK_LANGUAGES.map((l) => (
          <option key={l.code} value={l.code}>
            {f.languageName(l.code)}
          </option>
        ))}
      </select>
    </label>
  );
}
