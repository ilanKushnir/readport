/**
 * The subset of ICU MessageFormat this app's catalog uses, implemented in
 * a few dozen lines rather than pulled in as a library the bundle would
 * carry on every page load:
 *
 *   {name}                              a value, formatted if it is a number
 *   {n, number}                         a number in the locale's digits
 *   {n, plural, =0 {none} one {# book} other {# books}}
 *   {kind, select, ebook {Read} audio {Listen} other {Open}}
 *   {n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}
 *
 * Inside a plural, `#` is the count in the locale's digits. Exact matches
 * (`=0`) win over categories; categories come from Intl.PluralRules for the
 * locale, so Russian's `few`/`many` and Arabic's six forms need no code here.
 * Anything malformed renders as itself rather than throwing: a typo in one
 * translation must not take the page down.
 */

export type MessageValues = Record<string, string | number | boolean | null | undefined>;

interface Formatters {
  number: Intl.NumberFormat;
  plural: Intl.PluralRules;
  ordinal: Intl.PluralRules;
}
const cache = new Map<string, Formatters>();
function formattersFor(locale: string): Formatters {
  let f = cache.get(locale);
  if (!f) {
    let number: Intl.NumberFormat;
    let plural: Intl.PluralRules;
    let ordinal: Intl.PluralRules;
    try {
      number = new Intl.NumberFormat(locale);
      plural = new Intl.PluralRules(locale);
      ordinal = new Intl.PluralRules(locale, { type: 'ordinal' });
    } catch {
      number = new Intl.NumberFormat('en');
      plural = new Intl.PluralRules('en');
      ordinal = new Intl.PluralRules('en', { type: 'ordinal' });
    }
    f = { number, plural, ordinal };
    cache.set(locale, f);
  }
  return f;
}

/** Split `a {b} c {d {e}}` at top-level braces into text and argument tokens. */
function tokenize(message: string): { text: string; arg: boolean }[] {
  const out: { text: string; arg: boolean }[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < message.length; i++) {
    const ch = message[i];
    if (ch === '{') {
      if (depth === 0) {
        if (i > start) out.push({ text: message.slice(start, i), arg: false });
        start = i + 1;
      }
      depth += 1;
    } else if (ch === '}') {
      if (depth === 0) continue; // a stray brace is text
      depth -= 1;
      if (depth === 0) {
        out.push({ text: message.slice(start, i), arg: true });
        start = i + 1;
      }
    }
  }
  if (depth !== 0) return [{ text: message, arg: false }]; // unbalanced: render as-is
  if (start < message.length) out.push({ text: message.slice(start), arg: false });
  return out;
}

/** Parse `key {value} key2 {value}` option lists, where values may nest braces. */
function options(body: string): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i]!)) i++;
    const keyStart = i;
    while (i < body.length && body[i] !== '{' && !/\s/.test(body[i]!)) i++;
    const key = body.slice(keyStart, i).trim();
    while (i < body.length && /\s/.test(body[i]!)) i++;
    if (body[i] !== '{' || !key) break;
    let depth = 0;
    const valueStart = i + 1;
    for (; i < body.length; i++) {
      if (body[i] === '{') depth++;
      else if (body[i] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    out.set(key, body.slice(valueStart, i));
    i++;
  }
  return out;
}

export function formatMessage(locale: string, message: string, values: MessageValues = {}): string {
  return tokenize(message)
    .map((tok) => {
      if (!tok.arg) return tok.text;
      const parts = tok.text.split(',');
      const name = parts[0]!.trim();
      const type = parts[1]?.trim();
      const value = values[name];
      const { number, plural, ordinal } = formattersFor(locale);
      if (!type) {
        if (typeof value === 'number') return number.format(value);
        return value === undefined || value === null ? `{${name}}` : String(value);
      }
      if (type === 'number')
        return typeof value === 'number' ? number.format(value) : String(value ?? '');
      const body = parts.slice(2).join(',');
      const opts = options(body);
      if (type === 'plural' || type === 'selectordinal') {
        const n = typeof value === 'number' ? value : Number(value);
        const rules = type === 'plural' ? plural : ordinal;
        const chosen =
          opts.get(`=${n}`) ??
          opts.get(Number.isFinite(n) ? rules.select(n) : 'other') ??
          opts.get('other') ??
          '';
        return formatMessage(
          locale,
          chosen.replace(/#/g, Number.isFinite(n) ? number.format(n) : String(value ?? '')),
          values,
        );
      }
      if (type === 'select') {
        const chosen = opts.get(String(value ?? '')) ?? opts.get('other') ?? '';
        return formatMessage(locale, chosen, values);
      }
      return `{${name}}`;
    })
    .join('');
}

/** The argument names a message refers to, for checking translations against the source. */
export function messageArguments(message: string): string[] {
  const names = new Set<string>();
  const walk = (m: string) => {
    for (const tok of tokenize(m)) {
      if (!tok.arg) continue;
      const parts = tok.text.split(',');
      names.add(parts[0]!.trim());
      const type = parts[1]?.trim();
      if (type === 'plural' || type === 'selectordinal' || type === 'select') {
        for (const v of options(parts.slice(2).join(',')).values()) walk(v);
      }
    }
  };
  walk(message);
  return [...names];
}
