"""Rebuild the fonts and pictures the highlights PDF is set with.

    python3 -m venv .venv && .venv/bin/pip install fonttools pillow
    .venv/bin/python scripts/pdf-assets.py <upstream-fonts-dir>

The upstream directory holds the variable fonts as Google Fonts publishes
them (github.com/google/fonts, under ofl/<family>/), with each family's
OFL.txt saved as OFL-<family>.txt beside them:

    Literata[opsz,wght].ttf  Literata-Italic[opsz,wght].ttf
    Inter[opsz,wght].ttf     FrankRuhlLibre[wght].ttf
    NotoSansHebrew[wdth,wght].ttf  NotoNaskhArabic[wght].ttf
    NotoSansArabic[wdth,wght].ttf  NotoEmoji[wght].ttf
    NotoSansJP[wght].ttf  NotoSansSC[wght].ttf  NotoSansKR[wght].ttf

Typst reads a variable font only at its default instance, so every weight
and optical size the template asks for is pinned here as a static font of
its own ("Literata Display" is Literata at its display size). The CJK
families are cut down to what running text uses: Japanese to JIS X 0208,
Korean to every modern syllable, and Chinese to the whole unified block, so
a traditional passage or a rare kanji still finds a glyph there; each also
keeps every character the interface's own translation uses.

The pictures are the app's own (web/src/assets/art), recoloured for each
look: the fleuron in the accent, the quill and the harbour in the ink.

Writes server/fonts/pdf/ and server/typst/art/.
"""

import shutil
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
FONTS_OUT = ROOT / 'server' / 'fonts' / 'pdf'
ART_OUT = ROOT / 'server' / 'typst' / 'art'
I18N = ROOT / 'web' / 'src' / 'i18n' / 'messages'
ART_IN = ROOT / 'web' / 'src' / 'assets' / 'art'

WEIGHTS = {300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold'}


def rename(font, family, style):
    """Name a static cut so Typst files it under its family and weight."""
    name = font['name']
    for rec in list(name.names):
        if rec.nameID in (1, 2, 4, 6, 16, 17, 21, 22, 25):
            name.removeNames(nameID=rec.nameID)
    legacy = style if style in ('Regular', 'Italic', 'Bold', 'Bold Italic') else 'Regular'
    full = family if style == 'Regular' else f'{family} {style}'
    name.setName(family, 1, 3, 1, 0x409)
    name.setName(legacy, 2, 3, 1, 0x409)
    name.setName(full, 4, 3, 1, 0x409)
    name.setName(family.replace(' ', '') + '-' + style.replace(' ', ''), 6, 3, 1, 0x409)
    name.setName(family, 16, 3, 1, 0x409)
    name.setName(style, 17, 3, 1, 0x409)


def cut(src_dir, src, out, family, axes, italic=False, keep=None):
    font = TTFont(src_dir / src)
    tags = [a.axisTag for a in font['fvar'].axes] if 'fvar' in font else []
    font = instancer.instantiateVariableFont(font, {t: v for t, v in axes.items() if t in tags})
    weight = int(axes.get('wght', 400))
    font['OS/2'].usWeightClass = weight
    style = (WEIGHTS[weight] + (' Italic' if italic else '')).replace('Regular Italic', 'Italic')
    if italic:
        font['OS/2'].fsSelection |= 1
        font['head'].macStyle |= 2
    rename(font, family, style)
    if keep is not None:
        options = subset.Options()
        options.layout_features = ['*']
        options.name_IDs = ['*']
        options.name_languages = ['*']
        options.notdef_outline = True
        options.glyph_names = False
        subsetter = subset.Subsetter(options)
        subsetter.populate(unicodes=keep)
        subsetter.subset(font)
    font.save(FONTS_OUT / out)
    print(f'{out}: {(FONTS_OUT / out).stat().st_size // 1024} KB')


def chars_in(path):
    return {ord(c) for c in path.read_text(encoding='utf-8')}


def two_byte(codec, ranges):
    """A national standard's own repertoire: what its codec spells in two bytes."""
    keep = set()
    for lo, hi in ranges:
        for cp in range(lo, hi + 1):
            try:
                if len(chr(cp).encode(codec)) == 2:
                    keep.add(cp)
            except UnicodeEncodeError:
                pass
    return keep


def span(lo, hi):
    return set(range(lo, hi + 1))


def fonts(src_dir):
    FONTS_OUT.mkdir(parents=True, exist_ok=True)
    for old in FONTS_OUT.glob('*'):
        old.unlink()

    lit, lit_i = 'Literata[opsz,wght].ttf', 'Literata-Italic[opsz,wght].ttf'
    cut(src_dir, lit, 'Literata-Regular.ttf', 'Literata', {'opsz': 12, 'wght': 400})
    cut(src_dir, lit_i, 'Literata-Italic.ttf', 'Literata', {'opsz': 12, 'wght': 400}, italic=True)
    cut(src_dir, lit, 'LiterataDisplay-Regular.ttf', 'Literata Display', {'opsz': 60, 'wght': 400})
    cut(src_dir, lit_i, 'LiterataDisplay-Italic.ttf', 'Literata Display', {'opsz': 60, 'wght': 400}, italic=True)
    for w in (400, 500, 600):
        cut(src_dir, 'Inter[opsz,wght].ttf', f'Inter-{WEIGHTS[w]}.ttf', 'Inter', {'opsz': 14, 'wght': w})
    cut(src_dir, 'FrankRuhlLibre[wght].ttf', 'FrankRuhlLibre-Regular.ttf', 'Frank Ruhl Libre', {'wght': 400})
    for w in (400, 500):
        cut(src_dir, 'NotoSansHebrew[wdth,wght].ttf', f'NotoSansHebrew-{WEIGHTS[w]}.ttf',
            'Noto Sans Hebrew', {'wdth': 100, 'wght': w})
        cut(src_dir, 'NotoSansArabic[wdth,wght].ttf', f'NotoSansArabic-{WEIGHTS[w]}.ttf',
            'Noto Sans Arabic', {'wdth': 100, 'wght': w})
    cut(src_dir, 'NotoNaskhArabic[wght].ttf', 'NotoNaskhArabic-Regular.ttf', 'Noto Naskh Arabic', {'wght': 400})
    cut(src_dir, 'NotoEmoji[wght].ttf', 'NotoEmoji-Regular.ttf', 'Noto Emoji', {'wght': 400})

    base = span(0x20, 0x7E) | span(0xA0, 0x17F) | span(0x2000, 0x206F) | span(0x3000, 0x303F) | span(0xFF00, 0xFFEF)
    kana = span(0x3040, 0x30FF) | span(0x31F0, 0x31FF)
    hangul = span(0xAC00, 0xD7A3) | span(0x1100, 0x11FF) | span(0x3130, 0x318F)
    han = span(0x4E00, 0x9FFF) | span(0xF900, 0xFAFF)
    ja = base | kana | two_byte('shift_jis', [(0x4E00, 0x9FFF)]) | chars_in(I18N / 'ja.ts')
    ko = base | hangul | chars_in(I18N / 'ko.ts')
    zh = base | han | chars_in(I18N / 'zh-Hans.ts')
    cut(src_dir, 'NotoSansJP[wght].ttf', 'NotoSansJP-Regular.ttf', 'Noto Sans JP', {'wght': 400}, keep=ja)
    cut(src_dir, 'NotoSansKR[wght].ttf', 'NotoSansKR-Regular.ttf', 'Noto Sans KR', {'wght': 400}, keep=ko)
    cut(src_dir, 'NotoSansSC[wght].ttf', 'NotoSansSC-Regular.ttf', 'Noto Sans SC', {'wght': 400}, keep=zh)

    licences = {
        'literata': 'Literata', 'inter': 'Inter', 'frankruhllibre': 'FrankRuhlLibre',
        'notosanshebrew': 'NotoSansHebrew', 'notosansarabic': 'NotoSansArabic',
        'notonaskharabic': 'NotoNaskhArabic', 'notoemoji': 'NotoEmoji', 'notosansjp': 'NotoSansCJK',
    }
    for upstream, ours in licences.items():
        shutil.copyfile(src_dir / f'OFL-{upstream}.txt', FONTS_OUT / f'OFL-{ours}.txt')


# Each look's ink and accent, as the template's palette has them.
LOOKS = {
    'paper': {'ink': (47, 39, 32), 'accent': (164, 71, 31)},
    'night': {'ink': (226, 216, 199), 'accent': (230, 156, 116)},
}
# name, source, colour, opacity, widest it is ever printed (px)
PICTURES = [
    ('fleuron', 'fleuron', 'accent', 0.9, 360),
    ('quill', 'notes-empty', 'ink', 0.92, 440),
    ('harbour', 'harbour', 'ink', 0.16, 1229),
]


def art():
    ART_OUT.mkdir(parents=True, exist_ok=True)
    for look, colours in LOOKS.items():
        for name, source, key, opacity, width in PICTURES:
            im = Image.open(ART_IN / f'{source}.webp').convert('RGBA')
            alpha = im.getchannel('A').point(lambda a: int(a * opacity))
            tinted = Image.new('RGBA', im.size, colours[key] + (255,))
            tinted.putalpha(alpha)
            if tinted.width > width:
                tinted = tinted.resize((width, round(tinted.height * width / tinted.width)), Image.LANCZOS)
            tinted.save(ART_OUT / f'{name}-{look}.png', optimize=True)
            print(f'{name}-{look}.png: {tinted.size[0]}x{tinted.size[1]}')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    fonts(Path(sys.argv[1]))
    art()
