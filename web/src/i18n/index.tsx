import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  DEFAULT_UI_LOCALE,
  UI_LOCALES,
  suggestUiLocale,
  uiLocale,
  type UiLocale,
} from '@readport/shared';
import { api } from '../api/client';
import { useSession } from '../state/session';
import { formatMessage, type MessageValues } from './format';
import { en, type MessageKey } from './messages/en';

/**
 * The interface language.
 *
 * Which language the app speaks is decided in this order: the language this
 * account chose (kept on the server, so it follows the person to every
 * device); failing that, what the browser asks for; failing that, English.
 * Switching is a state change, not a reload - every `t()` re-renders - and
 * it sets the document's `lang` and `dir`, so Hebrew and Arabic turn the
 * whole shell right-to-left while a book keeps its own direction.
 *
 * English ships in the bundle. Every other language is fetched on demand,
 * and the page reads in English for the few hundred milliseconds that
 * takes rather than sitting blank.
 */

export type Messages = Record<string, string>;
export type TranslateFn = (key: MessageKey, values?: MessageValues) => string;

interface I18nCtx {
  locale: string;
  /** The locale as an Intl tag: `zh-Hans` and the rest as they are. */
  tag: string;
  dir: 'ltr' | 'rtl';
  /** Whether the current locale's strings have arrived (English always has). */
  ready: boolean;
  t: TranslateFn;
  /** Pick a language for this account; null returns to the browser's suggestion. */
  setLocale: (code: string | null) => Promise<void>;
  /** The locale the account chose, or null when following the browser. */
  chosen: string | null;
  locales: UiLocale[];
}

const LAST_KEY = 'rp-ui-locale';

function readLast(): string | null {
  try {
    return localStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
}
function writeLast(code: string | null): void {
  try {
    if (code) localStorage.setItem(LAST_KEY, code);
    else localStorage.removeItem(LAST_KEY);
  } catch {
    /* private mode */
  }
}

function browserSuggestion(): string {
  const languages =
    typeof navigator === 'undefined'
      ? []
      : navigator.languages?.length
        ? navigator.languages
        : [navigator.language];
  return suggestUiLocale(languages) ?? DEFAULT_UI_LOCALE;
}

/** Locale files, loaded once each and kept for the page. */
const loaded = new Map<string, Messages>([[DEFAULT_UI_LOCALE, en]]);
const loaders = import.meta.glob<{ default: Messages }>('./messages/*.ts');

async function loadMessages(code: string): Promise<Messages> {
  const have = loaded.get(code);
  if (have) return have;
  const loader = loaders[`./messages/${code}.ts`];
  if (!loader) return en;
  const mod = await loader();
  loaded.set(code, mod.default);
  return mod.default;
}

const Ctx = createContext<I18nCtx>({
  locale: DEFAULT_UI_LOCALE,
  tag: DEFAULT_UI_LOCALE,
  dir: 'ltr',
  ready: true,
  t: (key, values) => formatMessage(DEFAULT_UI_LOCALE, en[key] ?? key, values),
  setLocale: async () => {},
  chosen: null,
  locales: UI_LOCALES,
});

export const useI18n = () => useContext(Ctx);
export const useT = (): TranslateFn => useContext(Ctx).t;
export const useLocale = () => useContext(Ctx).locale;

export function I18nProvider({ children }: { children: ReactNode }) {
  const { user, locale: accountLocale, phase } = useSession();
  // Before the session answers, the last language this browser used, so a
  // returning reader does not see a flash of English on every launch.
  const [chosen, setChosen] = useState<string | null>(() => readLast());
  const [messages, setMessages] = useState<Messages>(() => {
    const first = readLast() ?? browserSuggestion();
    return loaded.get(first) ?? en;
  });
  const locale = uiLocale(chosen ?? '')?.code ?? browserSuggestion();
  const ready = loaded.has(locale);

  // The account's choice arrives with the session and outranks the memory.
  useEffect(() => {
    if (phase !== 'ready' || !user) return;
    setChosen(accountLocale ?? null);
    writeLast(accountLocale ?? null);
  }, [phase, user, accountLocale]);

  useEffect(() => {
    let alive = true;
    void loadMessages(locale).then((m) => {
      if (alive) setMessages(m);
    });
    return () => {
      alive = false;
    };
  }, [locale]);

  const spec = uiLocale(locale) ?? UI_LOCALES[0]!;
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.lang = spec.code;
    root.dir = spec.dir;
  }, [spec]);

  const t = useCallback<TranslateFn>(
    (key, values) => {
      const message = messages[key] ?? en[key] ?? key;
      return formatMessage(locale, message, values);
    },
    [messages, locale],
  );

  const setLocale = useCallback(
    async (code: string | null) => {
      setChosen(code);
      writeLast(code);
      if (user) {
        try {
          await api('/api/prefs/locale', { method: 'PUT', body: { locale: code } });
        } catch {
          /* kept locally; the next sign-in reads the server's answer */
        }
      }
    },
    [user],
  );

  const value = useMemo<I18nCtx>(
    () => ({
      locale: spec.code,
      tag: spec.code,
      dir: spec.dir,
      ready,
      t,
      setLocale,
      chosen,
      locales: UI_LOCALES,
    }),
    [spec, ready, t, setLocale, chosen],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
