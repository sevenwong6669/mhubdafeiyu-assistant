"""Draw the Porcelain theme glyphs and optionally prepare its local webfont.

Every glyph below is an original drawing for this project. The finish follows
the general soft-pillow technique of light grey skeuomorphic system icons:
bold solid silhouettes, small corner radii and edges that darken gently
toward every outline. No third-party artwork is traced, sampled or bundled.
"""

import argparse
import hashlib
import json
import math
import re
import shutil
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter


PANEL = Path(__file__).resolve().parents[1] / 'panel'
THEME = PANEL / 'themes' / 'porcelain'
SIZE = 28
SCALE = 4
COLUMNS = 8
LINE = 2.1
# Drawings use a 28-unit grid; GROW lets them fill about 85% of the cell.
GROW = 1.12
# Soft pillow finish: a light face that darkens slightly toward every edge.
FACE, EDGE = (184, 188, 191), (171, 175, 178)


class Pen:
    """Draws on a coverage mask; cut() knocks shapes out of a solid body."""

    def __init__(self):
        self.mask = Image.new('L', (SIZE * SCALE, SIZE * SCALE))
        self.draw = ImageDraw.Draw(self.mask)
        self.ink = 255

    def solid(self):
        self.ink = 255

    def cut(self):
        self.ink = 0

    def box(self, bounds):
        return tuple(round((14 + (v - 14) * GROW) * SCALE) for v in bounds)

    def px(self, width):
        return max(1, round(width * GROW * SCALE))

    def stroke(self, points, width=LINE):
        self.draw.line([self.box(p) for p in points], fill=self.ink, width=self.px(width), joint='curve')
        for x, y in (points[0], points[-1]):
            self.dot(x, y, width / 2)

    def rect(self, bounds, radius=2.3, fill=False, width=LINE):
        # Capsules stay round; other panels use the small radii of the style.
        if radius < min(bounds[2] - bounds[0], bounds[3] - bounds[1]) * .4:
            radius *= .45
        self.draw.rounded_rectangle(self.box(bounds), radius=self.px(radius),
                                    fill=self.ink if fill else None, outline=self.ink, width=self.px(width))

    def circle(self, x, y, r, width=LINE, fill=False):
        self.draw.ellipse(self.box((x-r, y-r, x+r, y+r)), fill=self.ink if fill else None,
                          outline=self.ink, width=self.px(width))

    def dot(self, x, y, r=1.05):
        self.draw.ellipse(self.box((x-r, y-r, x+r, y+r)), fill=self.ink)

    def arc(self, bounds, start, end, width=LINE):
        """Arc with round ends, matching the stroke caps."""
        self.draw.arc(self.box(bounds), start, end, fill=self.ink, width=self.px(width))
        cx, cy = (bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2
        rx, ry = (bounds[2] - bounds[0] - width) / 2, (bounds[3] - bounds[1] - width) / 2
        for angle in (start, end):
            a = math.radians(angle)
            self.dot(cx + rx * math.cos(a), cy + ry * math.sin(a), width / 2)

    def shape(self, points):
        self.draw.polygon([self.box(p) for p in points], fill=self.ink)


def engrave(mask):
    """Shade a coverage mask as a soft light-grey pillow."""
    erode = [mask.filter(ImageFilter.MinFilter(size)) for size in (3, 5, 9)]
    edge = ImageChops.subtract(mask, erode[0])
    for layer in erode[1:]:
        edge = ImageChops.add(edge, ImageChops.subtract(mask, layer))
    edge = edge.point(lambda v: min(255, v * 2 // 3)).filter(ImageFilter.GaussianBlur(SCALE * .5))
    edge = ImageChops.multiply(edge, mask)
    glyph = Image.composite(Image.new('RGB', mask.size, EDGE), Image.new('RGB', mask.size, FACE), edge).convert('RGBA')
    glyph.putalpha(mask)
    return glyph


def dashboard(p):
    p.rect((4, 5, 24, 23), 4, fill=True)
    p.cut()
    p.stroke([(9, 9.5), (9, 18.5)], 2)
    for y, end in ((10.4, 19.6), (14, 17.2), (17.6, 19.6)):
        p.stroke([(12.8, y), (end, y)], 1.7)


def keys(p):
    p.rect((3.5, 7.5, 24.5, 20.5), 3.2, fill=True)
    p.cut()
    for y in (11.2, 14.4):
        for x in (7.8, 11.9, 16.1, 20.2):
            p.dot(x, y, .95)
    p.stroke([(10.2, 17.5), (17.8, 17.5)], 1.5)


def call(p):
    p.shape([(7, 4), (11.4, 4), (13.3, 9.6), (10.6, 11.2), (12.4, 14.2),
             (16.8, 17.3), (18.9, 14.7), (24, 17), (24, 21.3), (21.7, 24),
             (17, 23.1), (12.6, 20.1), (8.4, 16), (5.3, 11.4), (4, 7.6)])


def pet(p):
    p.draw.ellipse(p.box((5, 8.4, 24.2, 21.6)), fill=255)
    p.shape([(6.6, 14.6), (2.3, 11.6), (2.6, 19.8), (6.6, 16.8)])
    p.stroke([(13.5, 6.4), (12, 4.6)], 1.5)
    p.stroke([(16.2, 6.6), (18, 4.8)], 1.5)
    p.cut()
    p.dot(18.4, 13.2, 1.35)
    p.shape([(24.8, 14.6), (21.4, 16.4), (24.8, 17.9)])
    p.arc((9.2, 10.5, 15.4, 19.5), 300, 420, 1.2)


def lamp(p):
    p.draw.ellipse(p.box((7.4, 4.6, 20.6, 17.6)), fill=255)
    p.shape([(9.2, 13.8), (18.8, 13.8), (16.9, 17.8), (11.1, 17.8)])
    p.rect((10.9, 18.7, 17.1, 20.9), 1.1, fill=True, width=.1)
    p.stroke([(12, 23.2), (16, 23.2)], 2)
    p.stroke([(4.2, 7.4), (2.3, 6.4)], 1.5)
    p.stroke([(23.8, 7.4), (25.7, 6.4)], 1.5)
    p.cut()
    p.arc((10, 7.2, 15.6, 12.8), 185, 265, 1.2)


def screen(p):
    p.rect((3.5, 6, 24.5, 20), 3, width=2.3)
    p.stroke([(8, 14.8), (11.3, 11.5), (14.1, 14.7), (18.2, 9.9), (20.5, 12.8)], 1.9)
    p.stroke([(10.6, 23.2), (17.4, 23.2)], 2.2)


def library(p):
    p.rect((5, 4.6, 22.6, 23.4), 3, fill=True)
    p.cut()
    p.stroke([(9.6, 4), (9.6, 24)], 1.4)
    for y, end in ((10, 18.6), (14, 18.6), (18, 16.4)):
        p.stroke([(12.8, y), (end, y)], 1.6)


def diagnostics(p):
    p.rect((3.7, 5.7, 24.3, 22.3), 4, fill=True)
    p.cut()
    p.stroke([(7, 14.8), (10.1, 14.8), (12.2, 10), (15.9, 18.4), (18.4, 13.8), (21, 13.8)], 1.9)


def dial(p):
    p.circle(14, 14, 9.4, 2.2)
    p.stroke([(14, 8.8), (14, 14), (17.8, 16.2)], 2.1)
    p.dot(14, 14, 1.5)


def work(p):
    p.arc((4.2, 4.8, 23.8, 24.2), 160, 376, 2.2)
    p.stroke([(14, 15.2), (19.6, 10.6)], 2.3)
    p.dot(13.6, 15.6, 1.9)
    p.stroke([(9.2, 20.8), (18.8, 20.8)], 1.9)


def alert(p):
    p.draw.ellipse(p.box((8, 4.6, 20, 16.6)), fill=255)
    p.shape([(8, 10.6), (20, 10.6), (20.2, 16.4), (22.8, 19.8), (5.2, 19.8), (7.8, 16.4)])
    p.dot(14, 22.4, 1.75)
    p.dot(14, 3.9, 1.1)


def mouse(p):
    p.rect((7.4, 3.2, 20.6, 24.8), 6.5, fill=True)
    p.cut()
    p.stroke([(6.8, 11.8), (21.2, 11.8)], 1.6)
    p.stroke([(14, 2.6), (14, 11.8)], 1.6)
    p.rect((11.9, 4.7, 16.1, 10.3), 2.1, fill=True, width=.1)
    p.solid()
    p.stroke([(14, 6.3), (14, 8.7)], 1.8)


def speaker(p):
    p.rect((3.1, 7, 24.9, 20.5), 3.5, fill=True)
    p.cut()
    p.circle(9, 13.7, 3.2, 1.5)
    p.circle(19, 13.7, 3.2, 1.5)
    p.dot(14, 17.1, .8)


def dock(p):
    p.rect((4, 12.2, 24, 22.4), 3.8, fill=True)
    p.stroke([(8, 12.4), (9.8, 7.8), (18.2, 7.8), (20, 12.4)], 2.1)
    p.cut()
    p.stroke([(9.6, 17.4), (17.4, 17.4)], 1.6)
    p.dot(20.9, 17.4, .9)


def headset(p):
    p.arc((4.9, 3.8, 23.1, 23), 180, 360, 2.3)
    p.rect((4.4, 12.3, 9.6, 21.4), 2.4, fill=True)
    p.rect((18.4, 12.3, 23.6, 21.4), 2.4, fill=True)
    p.stroke([(20.2, 21.4), (18.4, 23.4), (15, 23.4)], 1.7)


def device(p):
    p.rect((6.2, 4.8, 21.8, 23.2), 3.3, fill=True)
    p.cut()
    p.rect((9.8, 8.6, 18.2, 16.6), 1.3, fill=True, width=.1)
    p.dot(14, 19.8, 1.05)


def microphone(p):
    p.rect((10, 3.6, 18, 17.4), 4, fill=True)
    p.arc((6.2, 8, 21.8, 21), 0, 180, 2.1)
    p.stroke([(14, 21), (14, 24)], 2.1)
    p.stroke([(10.4, 24.2), (17.6, 24.2)], 2.1)
    p.cut()
    for y in (8.2, 10.9):
        p.stroke([(12.6, y), (15.4, y)], 1)


def balance(p):
    p.rect((4, 8, 24, 20.2), 3.2, fill=True)
    p.cut()
    for x, h in ((9, 3.4), (14, 5.4), (19, 7.4)):
        p.stroke([(x, 17.2), (x, 17.2 - h)], 2.4)


def subtitles(p):
    p.rect((4.2, 5.2, 23.8, 19.8), 3.2, fill=True)
    p.shape([(8.2, 19), (8.2, 23.8), (13.4, 19)])
    p.cut()
    p.stroke([(8.3, 11), (19.6, 11)], 1.8)
    p.stroke([(8.3, 14.9), (15.2, 14.9)], 1.8)


def rotate(p):
    p.arc((4.2, 4.2, 23.8, 23.8), 205, 330, 2.3)
    p.arc((4.2, 4.2, 23.8, 23.8), 25, 150, 2.3)
    p.shape([(21.5, 5.6), (24.2, 12.6), (17.2, 11.6)])
    p.shape([(6.5, 22.4), (3.8, 15.4), (10.8, 16.4)])


def appearance(p):
    p.rect((4.2, 5.6, 22.6, 19.2), 3, fill=True)
    p.stroke([(7.4, 22.3), (22.4, 22.3), (25, 19.7), (25, 9)], 1.8)
    p.cut()
    p.stroke([(8.3, 15.4), (11.1, 11.8), (13.9, 14.8), (16.6, 11.4), (19, 14.4)], 1.7)
    p.dot(17.8, 9.2, 1.25)


def power(p):
    p.arc((5, 5, 23, 23.2), 310, 590, 2.5)
    p.stroke([(14, 3.8), (14, 13.4)], 2.5)


def cancel(p):
    p.stroke([(7.6, 7.6), (20.4, 20.4)], 2.6)
    p.stroke([(20.4, 7.6), (7.6, 20.4)], 2.6)


def check(p):
    p.stroke([(6.4, 14.4), (11.4, 19.4), (21.6, 8.6)], 2.7)


def play(p):
    p.circle(14, 14, 10, fill=True)
    p.cut()
    p.shape([(11.6, 8.9), (19.6, 14), (11.6, 19.1)])


def globe(p):
    p.circle(14, 14, 9.8, 2.2)
    p.draw.ellipse(p.box((9.6, 4.4, 18.4, 23.6)), outline=255, width=p.px(1.7))
    p.stroke([(5.2, 14), (22.8, 14)], 1.7)


def arrow(p):
    p.stroke([(11, 7.4), (17.6, 14), (11, 20.6)], 2.4)


def palette(p):
    p.rect((4.2, 5.2, 23.8, 22.8), 4, fill=True)
    p.cut()
    for x in (9, 14, 19):
        p.stroke([(x, 8.4), (x, 19.6)], 1.3)
    for x, y in ((9, 12), (14, 16.4), (19, 10.8)):
        p.dot(x, y, 2.85)
    p.solid()
    for x, y in ((9, 12), (14, 16.4), (19, 10.8)):
        p.dot(x, y, 2.05)


GLYPHS = (dashboard, keys, call, pet, lamp, screen, library, diagnostics,
          dial, work, alert, mouse, speaker, dock, headset, device,
          microphone, balance, subtitles, rotate, appearance, power, cancel, check,
          play, globe, arrow, palette)


def generate_icons():
    rows = (len(GLYPHS) + COLUMNS - 1) // COLUMNS
    atlas = Image.new('RGBA', (SIZE * SCALE * COLUMNS, SIZE * SCALE * rows))
    css = ['/* Generated from the original drawings in scripts/build-porcelain-assets.py. */',
           f'html[data-theme="porcelain"] .porcelain-glyph {{ background-size: {COLUMNS * 100}% {rows * 100}%; }}']
    for i, draw in enumerate(GLYPHS):
        pen = Pen()
        draw(pen)
        y, x = divmod(i, COLUMNS)
        atlas.paste(engrave(pen.mask), (x * SIZE * SCALE, y * SIZE * SCALE))
        css.append(f'html[data-theme="porcelain"] [data-porcelain-glyph="{draw.__name__}"]'
                   f' {{ background-position: {x/(COLUMNS-1):.8%} {y/(rows-1):.8%}; }}')
    atlas.save(THEME / 'glyphs.png', optimize=True)
    (THEME / 'glyphs.css').write_text('\n'.join(css) + '\n', encoding='utf-8')


def generate_font(source, notice, revision):
    from fontTools import subset
    from fontTools.ttLib import TTFont

    if not re.fullmatch(r'[0-9a-f]{40}', revision):
        raise ValueError('Supply the Google Fonts source commit.')
    characters = set()
    for file in (PANEL / 'i18n').glob('*.json'):
        catalog = json.loads(file.read_text(encoding='utf-8-sig'))
        for key, value in catalog.items():
            characters.update(key + (value if isinstance(value, str) else ''))
    for row in range(0xB0, 0xD8):
        for column in range(0xA1, 0xFF):
            characters.update(bytes((row, column)).decode('gb2312', errors='ignore'))
    codepoints = {ord(character) for character in characters}
    for start, end in ((0x20, 0x024F), (0x0300, 0x052F), (0x2000, 0x206F),
                       (0x3000, 0x303F), (0xFF00, 0xFFEF)):
        codepoints.update(range(start, end + 1))

    options = subset.Options()
    options.name_IDs = ['*']
    options.recalc_timestamp = False
    options.hinting = True
    font = TTFont(source, recalcTimestamp=False)
    sub = subset.Subsetter(options=options)
    sub.populate(unicodes=codepoints)
    sub.subset(font)
    names = font['name']
    replaces = {1:'Porcelain UI', 4:'Porcelain UI Regular', 6:'PorcelainUI-Regular',
                16:'Porcelain UI', 18:'Porcelain UI Regular', 21:'Porcelain UI', 25:'PorcelainUI'}
    for name in list(names.names):
        if name.nameID in replaces:
            name.string = replaces[name.nameID].encode(name.getEncoding())
    for instance in font['fvar'].instances:
        if instance.postscriptNameID != 0xFFFF:
            old = names.getDebugName(instance.postscriptNameID)
            suffix = re.sub(r'[^\w]', '', old.rsplit('-', 1)[-1]) if old else 'Regular'
            for record in names.names:
                if record.nameID == instance.postscriptNameID:
                    record.string = ('PorcelainUI-' + suffix).encode(record.getEncoding())
    font.flavor = 'woff2'
    folder = THEME / 'fonts'
    folder.mkdir(exist_ok=True)
    output = folder / 'PorcelainUI.woff2'
    font.save(output)
    shutil.copyfile(notice, folder / 'OFL.txt')
    details = {'family':'Porcelain UI', 'basedOn':'Noto Sans SC', 'license':'OFL-1.1',
               'source':'https://github.com/google/fonts/tree/' + revision + '/ofl/notosanssc',
               'sha256':hashlib.sha256(output.read_bytes()).hexdigest(),
               'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),
               'format':'WOFF2, variable weight, subset for the panel languages',
               'glyphs':len(font.getBestCmap())}
    (folder / 'source.json').write_text(json.dumps(details, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({**details, 'bytes':output.stat().st_size}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--font', type=Path)
    parser.add_argument('--notice', type=Path)
    parser.add_argument('--revision')
    arguments = parser.parse_args()
    THEME.mkdir(exist_ok=True)
    generate_icons()
    if arguments.font:
        if not arguments.notice or not arguments.revision:
            parser.error('--font requires --notice and --revision')
        generate_font(arguments.font, arguments.notice, arguments.revision)
