import { describe, expect, it } from 'vitest';
import {
  BOOK_LANGUAGES,
  LANGUAGES,
  languageByCode,
  languageFlag,
  normaliseLanguage,
} from './languages.js';

/**
 * The flag beside a language name is decoration with a convention behind
 * it: every language this build names carries exactly one, it is a real
 * flag rather than a letter pair or a placeholder, and asking by any
 * spelling of the code - "pt-BR", "POR" - gets the same one.
 */

/** Two regional indicator symbols, or a subdivision flag (🏴 + tag sequence). */
const FLAG = /^(?:[\u{1F1E6}-\u{1F1FF}]{2}|\u{1F3F4}[\u{E0061}-\u{E007A}]+\u{E007F})$/u;

describe('language flags', () => {
  it('every language this build names has one real flag', () => {
    for (const l of BOOK_LANGUAGES) {
      expect(l.flag, `${l.code} (${l.label})`).toMatch(FLAG);
    }
  });
  it('names each code once, and the romanizer languages are book languages too', () => {
    const codes = BOOK_LANGUAGES.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const l of LANGUAGES) expect(codes).toContain(l.code);
  });
  it('follows the convention for the flags people will see most', () => {
    expect(languageFlag('en')).toBe('🇬🇧');
    expect(languageFlag('es')).toBe('🇪🇸');
    expect(languageFlag('pt')).toBe('🇵🇹');
    expect(languageFlag('ar')).toBe('🇸🇦');
    expect(languageFlag('zh')).toBe('🇨🇳');
    expect(languageFlag('he')).toBe('🇮🇱');
    expect(languageFlag('ru')).toBe('🇷🇺');
    expect(languageFlag('uk')).toBe('🇺🇦');
  });
  it('ignores a region suffix and case, as every other lookup does', () => {
    expect(languageFlag('pt-BR')).toBe(languageFlag('pt'));
    expect(languageFlag('EN_US')).toBe('🇬🇧');
    expect(languageFlag(normaliseLanguage('por'))).toBe('🇵🇹');
    expect(languageByCode('he-IL')?.flag).toBe('🇮🇱');
  });
  it('has nothing to show for a language it does not know, or for none', () => {
    expect(languageFlag('tlh')).toBe('');
    expect(languageFlag('unknown')).toBe('');
    expect(languageFlag(null)).toBe('');
    expect(languageFlag(undefined)).toBe('');
  });
});
