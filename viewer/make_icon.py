#!/usr/bin/env python3
"""Generate icon.ico for Eagle Viewer from Microsoft Fluent Emoji eagle."""
import io
import urllib.request
from pathlib import Path
from PIL import Image, ImageDraw

# Microsoft Fluent Emoji – Eagle (color SVG, open source, MIT license)
_EAGLE_SVG_URL = (
    "https://raw.githubusercontent.com/microsoft/fluentui-emoji/"
    "main/assets/Eagle/Color/eagle_color.svg"
)

def _fetch_eagle(size: int) -> Image.Image:
    import cairosvg
    with urllib.request.urlopen(_EAGLE_SVG_URL, timeout=15) as r:
        svg_data = r.read()
    png_data = cairosvg.svg2png(bytestring=svg_data, output_width=size, output_height=size)
    return Image.open(io.BytesIO(png_data)).convert("RGBA")


def _compose(eagle: Image.Image, total: int) -> Image.Image:
    """Place eagle on white rounded-square background (matches icon.svg design)."""
    bg = Image.new("RGBA", (total, total), (0, 0, 0, 0))
    d  = ImageDraw.Draw(bg)
    r  = int(total * 96 / 512)  # same corner radius ratio as original SVG
    d.rounded_rectangle([0, 0, total - 1, total - 1], radius=r, fill=(255, 255, 255, 255))

    # Center eagle with 10% padding
    pad   = int(total * 0.10)
    inner = total - pad * 2
    eagle = eagle.resize((inner, inner), Image.LANCZOS)
    bg.paste(eagle, (pad, pad), eagle)
    return bg


def main():
    print("Fetching Fluent Emoji eagle…")
    eagle_src = _fetch_eagle(512)

    out  = Path(__file__).parent / "icon.ico"
    sizes = [256, 128, 64, 48, 32, 16]
    frames = [_compose(eagle_src.copy(), s) for s in sizes]
    frames[0].save(out, format="ICO", sizes=[(s, s) for s in sizes])
    kb = out.stat().st_size // 1024
    print(f"Saved: {out}  ({kb} KB, {len(sizes)} sizes: {sizes})")


if __name__ == "__main__":
    main()
