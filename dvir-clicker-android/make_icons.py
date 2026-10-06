"""Generate the launcher icons from the game's Dvir image.

Usage: python3 make_icons.py   (run from this directory; needs Pillow)
"""
from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
SRC = HERE.parent / "dvir-clicker" / "dvir.webp"
RES = HERE / "res"

DENSITIES = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}
GOLD_LIGHT = (255, 228, 138)
GOLD = (255, 196, 46)
GOLD_DEEP = (255, 154, 31)


def radial_gold(size):
    """Gold radial gradient matching the in-game button."""
    img = Image.new("RGB", (size, size))
    px = img.load()
    cx, cy = size * 0.35, size * 0.30
    max_d = ((size - cx) ** 2 + (size - cy) ** 2) ** 0.5
    for y in range(size):
        for x in range(size):
            t = (((x - cx) ** 2 + (y - cy) ** 2) ** 0.5) / max_d
            if t < 0.45:
                a, b, k = GOLD_LIGHT, GOLD, t / 0.45
            else:
                a, b, k = GOLD, GOLD_DEEP, (t - 0.45) / 0.55
            px[x, y] = tuple(round(a[i] + (b[i] - a[i]) * k) for i in range(3))
    return img.convert("RGBA")


def circle_mask(size, inset=0):
    big = size * 4
    m = Image.new("L", (big, big), 0)
    ImageDraw.Draw(m).ellipse((inset * 4, inset * 4, big - 1 - inset * 4, big - 1 - inset * 4), fill=255)
    return m.resize((size, size), Image.LANCZOS)


def save(img, folder, name):
    out = RES / folder / name
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out, optimize=True)


def main():
    dvir = Image.open(SRC).convert("RGBA")

    for density, scale in DENSITIES.items():
        folder = f"mipmap-{density}"

        # Adaptive icon (API 26+): 108dp layers, launcher masks the centre 72dp.
        full = round(108 * scale)
        save(radial_gold(full), folder, "ic_launcher_background.png")
        fg = Image.new("RGBA", (full, full), (0, 0, 0, 0))
        d = round(full * 0.76)
        fg.alpha_composite(dvir.resize((d, d), Image.LANCZOS), ((full - d) // 2, full - d))
        save(fg, folder, "ic_launcher_foreground.png")

        # Legacy round icon (API 24-25): gold coin with a cream rim.
        size = round(48 * scale)
        rim = max(1, round(size * 0.05))
        coin = radial_gold(size)
        coin.alpha_composite(dvir.resize((size, size), Image.LANCZOS))
        icon = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        ring = Image.new("RGBA", (size, size), (255, 243, 196, 255))
        icon.paste(ring, (0, 0), circle_mask(size))
        icon.paste(coin, (0, 0), circle_mask(size, rim))
        save(icon, folder, "ic_launcher.png")
        save(icon, folder, "ic_launcher_round.png")


if __name__ == "__main__":
    main()
