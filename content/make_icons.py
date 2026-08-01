"""Generate the PWA icons: 語 on the app's accent blue.

Regenerate with: python content/make_icons.py
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

BASE = Path(__file__).resolve().parent.parent
ICONS = BASE / 'icons'

BG = (32, 38, 52)
FG = (110, 168, 254)
GLYPH = '\u8a9e'  # 語 — "language"

# Windows ships these; the first one that loads wins.
FONT_CANDIDATES = [
    'C:/Windows/Fonts/YuGothB.ttc',
    'C:/Windows/Fonts/meiryob.ttc',
    'C:/Windows/Fonts/msgothic.ttc',
    'C:/Windows/Fonts/YuGothM.ttc',
]


def load_font(size):
    for path in FONT_CANDIDATES:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def draw_icon(size, padding_ratio=0.0):
    """padding_ratio > 0 leaves the safe margin Android maskable icons need."""
    image = Image.new('RGBA', (size, size), BG + (255,))
    draw = ImageDraw.Draw(image)

    radius = int(size * 0.22)
    draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=BG)

    usable = size * (1 - padding_ratio * 2)
    font = load_font(int(usable * 0.62))
    box = draw.textbbox((0, 0), GLYPH, font=font)
    draw.text(
        ((size - (box[2] - box[0])) / 2 - box[0],
         (size - (box[3] - box[1])) / 2 - box[1]),
        GLYPH,
        font=font,
        fill=FG,
    )
    return image


def main():
    ICONS.mkdir(exist_ok=True)
    for size in (192, 512):
        draw_icon(size).save(ICONS / f'icon-{size}.png')
        print(f'icons/icon-{size}.png')

    # Maskable icons get cropped to a circle on Android, so keep the glyph well
    # inside the safe area.
    draw_icon(512, padding_ratio=0.1).save(ICONS / 'icon-maskable-512.png')
    print('icons/icon-maskable-512.png')

    draw_icon(180).save(ICONS / 'apple-touch-icon.png')
    print('icons/apple-touch-icon.png')

    draw_icon(64).resize((32, 32), Image.LANCZOS).save(ICONS / 'favicon-32.png')
    print('icons/favicon-32.png')


if __name__ == '__main__':
    main()
