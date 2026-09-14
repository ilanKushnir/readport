import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = fs.readFileSync(new URL('../styles/immersive.css', import.meta.url), 'utf8');

describe('coarse selection dock touch targets', () => {
  it('overrides compact sizing for every button, including swatches', () => {
    const coarse = css.slice(css.lastIndexOf('@media (any-pointer: coarse)'));
    const buttons =
      /\.selection-menu\[data-compact='true'\] button,\s*\.selection-menu\[data-compact='true'\] button:not\(\.swatch\)\s*\{([^}]+)\}/.exec(
        coarse,
      )?.[1];
    expect(buttons ?? '').toMatch(/min-width:\s*44px/);
    expect(buttons ?? '').toMatch(/min-height:\s*44px/);
  });
  it('gives the dock enough height for its full interactive targets', () => {
    const coarse = css.slice(css.lastIndexOf('@media (any-pointer: coarse)'));
    const dock = /\.selection-menu\[data-compact='true'\]\s*\{([^}]+)\}/.exec(coarse)?.[1];
    expect(dock ?? '').toMatch(/height:\s*44px/);
  });
});
