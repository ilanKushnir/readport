/**
 * The two ways of showing where the voice is, drawn.
 *
 * A small page of five lines, the third of them being read: with a mark
 * in the margin beside it, or with the sentence itself - the end of the
 * second line and the start of the third - washed in the accent. The
 * stylesheet colours the parts, so the drawing takes the theme it sits in
 * and mirrors for a right-to-left page.
 */
export function VoiceMarkGlyph({ kind }: { kind: 'margin' | 'wash' }) {
  // Each line's start and width, in the drawing's own units; the last is
  // short, as the end of a paragraph is.
  const lines: [number, number][] = [
    [14, 72],
    [14, 60],
    [14, 76],
    [14, 48],
    [14, 66],
  ];
  return (
    <svg className="vm-glyph" viewBox="0 0 100 60" aria-hidden="true" focusable="false">
      {kind === 'wash' && (
        <>
          <rect className="vm-glyph__wash" x="44" y="15" width="32" height="12" rx="4" />
          <rect className="vm-glyph__wash" x="11" y="25" width="54" height="12" rx="4" />
        </>
      )}
      {lines.map(([x, width], i) => (
        <rect
          key={i}
          className="vm-glyph__line"
          x={x}
          y={9 + i * 10}
          width={width}
          height="4"
          rx="2"
        />
      ))}
      {kind === 'margin' && (
        <rect className="vm-glyph__mark" x="5" y="25" width="3" height="12" rx="1.5" />
      )}
    </svg>
  );
}
