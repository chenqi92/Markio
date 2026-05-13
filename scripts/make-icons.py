#!/usr/bin/env python3
"""Generate platform icon sources for Tauri + in-app brand assets.

Output:
- assets/icon-mac.png       1024×1024, content squircle-masked, Apple icon-grid padded
- assets/icon-win.png       1024×1024, content squircle-masked (smaller radius)
- public/brand/icon-*.png   1024 / 512 / 256, squircle-masked (for the React UI)

Then run `pnpm tauri icon assets/icon-mac.png` to generate the full Tauri icon set
(icns / ico / png / iOS / Android assets) into src-tauri/icons/.
"""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC_LIGHT = ROOT / "md-view-light.png"
SRC_DARK = ROOT / "md-view-dark.png"
OUT_DIR = ROOT / "public" / "brand"
ASSETS_DIR = ROOT / "assets"
OUT_DIR.mkdir(parents=True, exist_ok=True)
ASSETS_DIR.mkdir(parents=True, exist_ok=True)

# macOS Big Sur icon grid:
#  - canvas 1024×1024
#  - content fits inside a 824×824 rounded-rect (≈ 80.5%)
#  - corner radius ≈ 22.37% of the content side (≈ 184px)
APPLE_INSET = 100
APPLE_RADIUS_RATIO = 22.37 / 100
# Windows / general: slight rounded corners (~12% radius), no extra padding
WIN_RADIUS_RATIO = 12 / 100


def square(img: Image.Image) -> Image.Image:
    w, h = img.size
    if w == h:
        return img
    s = min(w, h)
    left = (w - s) // 2
    top = (h - s) // 2
    return img.crop((left, top, left + s, top + s))


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def to_mac_padded(src: Path, dst: Path, size: int = 1024,
                  inset: int = APPLE_INSET) -> None:
    img = Image.open(src).convert("RGBA")
    img = square(img)
    content_size = size - inset * 2
    img = img.resize((content_size, content_size), Image.LANCZOS)

    # squircle-ish mask on the content layer
    radius = int(content_size * APPLE_RADIUS_RATIO)
    mask = rounded_mask(content_size, radius)
    rounded = Image.new("RGBA", (content_size, content_size), (0, 0, 0, 0))
    rounded.paste(img, (0, 0), mask)

    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(rounded, (inset, inset), rounded)
    canvas.save(dst, "PNG")


def to_rounded(src: Path, dst: Path, size: int = 1024,
               radius_ratio: float = WIN_RADIUS_RATIO) -> None:
    img = Image.open(src).convert("RGBA")
    img = square(img)
    img = img.resize((size, size), Image.LANCZOS)
    radius = int(size * radius_ratio)
    mask = rounded_mask(size, radius)
    rounded = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    rounded.paste(img, (0, 0), mask)
    rounded.save(dst, "PNG")


def main():
    if not SRC_LIGHT.exists() or not SRC_DARK.exists():
        raise SystemExit(f"missing source PNG: {SRC_LIGHT} / {SRC_DARK}")

    # In-app brand assets (used in welcome + windows brand chip).
    # 24% radius so they look like macOS app icons within the UI too.
    for src, key in [(SRC_LIGHT, "light"), (SRC_DARK, "dark")]:
        for s in (1024, 512, 256):
            to_rounded(src, OUT_DIR / f"icon-{key}-{s}.png", size=s,
                       radius_ratio=24 / 100)

    # macOS bundle icon source (Apple icon-grid + squircle on the content).
    to_mac_padded(SRC_LIGHT, ASSETS_DIR / "icon-mac.png", size=1024)
    # Windows bundle icon source (no Apple padding, rounded ~12%).
    to_rounded(SRC_LIGHT, ASSETS_DIR / "icon-win.png", size=1024,
               radius_ratio=WIN_RADIUS_RATIO)

    print("generated:")
    for p in sorted(OUT_DIR.glob("*.png")):
        print(" ", p.relative_to(ROOT))
    for p in sorted(ASSETS_DIR.glob("*.png")):
        print(" ", p.relative_to(ROOT))


if __name__ == "__main__":
    main()
