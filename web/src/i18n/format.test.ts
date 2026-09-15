import { describe, expect, it } from 'vitest';
import { formatMessage, messageArguments } from './format';

describe('formatMessage', () => {
  it('substitutes values and formats numbers in the locale', () => {
    expect(formatMessage('en', 'Hello, {name}', { name: 'Ada' })).toBe('Hello, Ada');
    expect(formatMessage('de', '{n} books', { n: 1234 })).toBe('1.234 books');
    expect(formatMessage('en', '{n, number} books', { n: 1234 })).toBe('1,234 books');
  });

  it('chooses plural forms by the locale, exact matches first', () => {
    const msg = '{n, plural, =0 {No books} one {# book} other {# books}}';
    expect(formatMessage('en', msg, { n: 0 })).toBe('No books');
    expect(formatMessage('en', msg, { n: 1 })).toBe('1 book');
    expect(formatMessage('en', msg, { n: 5 })).toBe('5 books');
    const ru = '{n, plural, one {# книга} few {# книги} many {# книг} other {# книги}}';
    expect(formatMessage('ru', ru, { n: 1 })).toBe('1 книга');
    expect(formatMessage('ru', ru, { n: 3 })).toBe('3 книги');
    expect(formatMessage('ru', ru, { n: 11 })).toBe('11 книг');
    const ar = '{n, plural, zero {لا} one {واحد} two {اثنان} few {قليل} many {كثير} other {أخرى}}';
    expect(formatMessage('ar', ar, { n: 2 })).toBe('اثنان');
    expect(formatMessage('ar', ar, { n: 100 })).toBe('أخرى');
  });

  it("handles ordinals through the locale's ordinal rules", () => {
    const msg = '{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}';
    expect(formatMessage('en', msg, { n: 1 })).toBe('1st');
    expect(formatMessage('en', msg, { n: 2 })).toBe('2nd');
    expect(formatMessage('en', msg, { n: 3 })).toBe('3rd');
    expect(formatMessage('en', msg, { n: 11 })).toBe('11th');
    expect(formatMessage('en', msg, { n: 22 })).toBe('22nd');
  });

  it('selects by a value, with a fallback', () => {
    const msg = '{kind, select, ebook {Read} audio {Listen} other {Open}}';
    expect(formatMessage('en', msg, { kind: 'ebook' })).toBe('Read');
    expect(formatMessage('en', msg, { kind: 'video' })).toBe('Open');
  });

  it('nests arguments inside plural branches', () => {
    const msg = '{n, plural, one {{name} has # book} other {{name} has # books}}';
    expect(formatMessage('en', msg, { n: 2, name: 'Ada' })).toBe('Ada has 2 books');
  });

  it('never throws on a broken message', () => {
    expect(formatMessage('en', 'a {b c', {})).toBe('a {b c');
    expect(formatMessage('en', 'a } b', {})).toBe('a } b');
    expect(formatMessage('en', '{missing}', {})).toBe('{missing}');
    expect(formatMessage('en', '{n, plural, one {x}}', { n: 3 })).toBe('');
  });

  it('lists the arguments a message uses, including inside branches', () => {
    expect(
      messageArguments('{n, plural, one {{name} has # book} other {# books in {place}}}').sort(),
    ).toEqual(['n', 'name', 'place']);
  });
});
