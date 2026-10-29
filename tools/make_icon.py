"""Draws the Containers icon: three browser windows stacked diagonally, the
two behind fading like Model Librarian's bands (and nodding to Multi-Account
Containers' overlapping frames), the front one with an ink tab strip and
Prompto's red orb, on the same white rounded tile with a lavender hairline
(Model-Librarian-Gallery, tools/make_icon.py) so the tools match. Separate
windows, separate identities: that's what a container is.

    python tools/make_icon.py              # static/icons/icon{16,32,48,128}.png and docs/images/icon.png
    python tools/make_icon.py --preview D  # the same images, written to folder D instead

Needs Pillow and NumPy. Everything is drawn on a 512 grid at 4x and scaled
down with LANCZOS. The small sizes (toolbar, tab strip) use simplified artwork
rather than a plain shrink: no strips on the back windows, a taller tab strip
and a bigger orb.
"""

import os
import sys

import numpy as np
from PIL import Image, ImageChops, ImageDraw

SS = 4                      # supersampling factor
G = 512 * SS                # drawing grid
INK = (16, 17, 23)
HOLO = [(0.0, "#f7dccf"), (0.3, "#f4a7c0"), (0.62, "#b9a3e3"), (1.0, "#8fcfe3")]
ORB = [(0.0, "#fff1f1"), (0.22, "#ffb3b3"), (0.6, "#f26d6d"), (1.0, "#c23b4a")]

FRONT = (64, 212, 380, 436)                     # the front window (left, top, right, bottom)
STEP = 34                   # each window behind sits this far up and right
BACK_ALPHAS = (160, 95)     # the windows behind are the same sheet, fainter with distance
BACK_STRIP_ALPHA = 45       # their tab strips: a faint tint; more muddies the pink
RADIUS = 26


def S(v):
    return round(v * SS)


def rgb(h):
    h = h.lstrip("#")
    return np.array([int(h[i:i + 2], 16) for i in (0, 2, 4)], dtype=np.float32)


def ramp(t, stops):
    """Colour at t (array, 0..1) along gradient stops."""
    t = np.clip(t, 0, 1)
    out = np.zeros(t.shape + (3,), dtype=np.float32)
    for (a, ca), (b, cb) in zip(stops, stops[1:]):
        m = (t >= a) & (t <= b)
        k = ((t - a) / (b - a))[..., None]
        out[m] = (rgb(ca) * (1 - k) + rgb(cb) * k)[m]
    return out


def layer(color_fn, mask):
    """An RGBA layer: colours from color_fn(xx, yy), alpha from an L mask."""
    yy, xx = np.mgrid[0:G, 0:G].astype(np.float32)
    a = np.asarray(mask, dtype=np.float32)[..., None]
    return Image.fromarray(np.concatenate([color_fn(xx, yy), a], axis=2).astype(np.uint8), "RGBA")


def solid(color, mask):
    out = Image.new("RGBA", (G, G), color + (0,))
    out.putalpha(mask)
    return out


def holo(xx, yy):
    """One diagonal sweep across all the windows, as if cut from one sheet."""
    x0, y0, x1, y1 = S(64), S(144), S(448), S(436)
    return ramp(((xx - x0) / (x1 - x0) + (yy - y0) / (y1 - y0)) / 2, HOLO)


def tile(img):
    ImageDraw.Draw(img).rounded_rectangle([S(16), S(16), S(496), S(496)], radius=S(108),
                                          fill=(255, 255, 255, 255), outline=(220, 219, 227, 255), width=S(10))


def back_windows(img, small):
    """The windows behind, farthest first, each with a white gap so it reads as
    sitting on the one behind it."""
    x0, y0, x1, y1 = FRONT
    for i in reversed(range(len(BACK_ALPHAS))):
        d = STEP * (i + 1)
        bx0, by0, bx1, by1 = x0 + d, y0 - d, x1 + d, y1 - d
        gap = Image.new("L", (G, G), 0)
        ImageDraw.Draw(gap).rounded_rectangle([S(bx0 - 10), S(by0 - 10), S(bx1 + 10), S(by1 + 10)],
                                              radius=S(RADIUS + 10), fill=255)
        img.alpha_composite(solid((255, 255, 255), gap))
        card = Image.new("L", (G, G), 0)
        ImageDraw.Draw(card).rounded_rectangle([S(bx0), S(by0), S(bx1), S(by1)], radius=S(RADIUS), fill=255)
        img.alpha_composite(layer(holo, card.point(lambda v, a=BACK_ALPHAS[i]: v * a // 255)))
        if not small:
            band = Image.new("L", (G, G), 0)
            ImageDraw.Draw(band).rectangle([S(bx0), S(by0), S(bx1), S(by0 + 58)], fill=255)
            band = ImageChops.multiply(band, card).point(lambda v: v * BACK_STRIP_ALPHA // 255)
            img.alpha_composite(solid(INK, band))


def tab_shape(x0, x1, top, base, r_top, r_foot):
    """A browser tab standing on `base`: rounded top, feet that curve out into the strip."""
    m = Image.new("L", (G, G), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([S(x0), S(top), S(x1), S(base + r_top)], radius=S(r_top), fill=255)
    for fx, cx in ((x0 - r_foot, x0 - r_foot), (x1, x1 + r_foot)):
        d.rectangle([S(fx), S(base - r_foot), S(fx + r_foot), S(base)], fill=255)
        d.ellipse([S(cx - r_foot), S(base - 2 * r_foot), S(cx + r_foot), S(base)], fill=0)
    return m


def front_window(img, small):
    """The front window, with a white gap round it so it reads as sitting on top."""
    x0, y0, x1, y1 = FRONT
    gap = Image.new("L", (G, G), 0)
    ImageDraw.Draw(gap).rounded_rectangle([S(x0 - 12), S(y0 - 12), S(x1 + 12), S(y1 + 12)], radius=S(RADIUS + 12), fill=255)
    img.alpha_composite(solid((255, 255, 255), gap))
    window = Image.new("L", (G, G), 0)
    ImageDraw.Draw(window).rounded_rectangle([S(x0), S(y0), S(x1), S(y1)], radius=S(RADIUS), fill=255)
    img.alpha_composite(layer(holo, window))

    # Ink tab strip across the top, with the active tab cut out of it in the
    # window's own colours: the tab and the page are one sheet.
    strip = 70 if small else 58
    band = Image.new("L", (G, G), 0)
    ImageDraw.Draw(band).rectangle([S(x0), S(y0), S(x1), S(y0 + strip)], fill=255)
    band = ImageChops.multiply(band, window)
    if small:
        tab = tab_shape(x0 + 38, x0 + 196, y0 + 20, y0 + strip, 16, 12)
    else:
        tab = tab_shape(x0 + 32, x0 + 168, y0 + 16, y0 + strip, 14, 11)
    band = ImageChops.subtract(band, tab)
    img.alpha_composite(solid(INK, band))
    if not small:
        # Two more tabs in the strip, as faint outlines of where other sites sit.
        for i in range(2):
            tx = x0 + 186 + i * 58
            ImageDraw.Draw(img).rounded_rectangle([S(tx), S(y0 + 27), S(tx + 40), S(y0 + 35)], radius=S(4),
                                                  fill=(255, 255, 255, 70))


def orb(img, cx, cy, radius):
    X, Y, R = S(cx), S(cy), S(radius)
    mask = Image.new("L", (G, G), 0)
    ImageDraw.Draw(mask).ellipse([X - R, Y - R, X + R, Y + R], fill=255)
    # radial gradient: focus at (34%, 30%) of the orb's box, radius 75% of its width
    fx, fy, fr = X - R + 0.34 * 2 * R, Y - R + 0.30 * 2 * R, 0.75 * 2 * R
    img.alpha_composite(layer(lambda xx, yy: ramp(np.hypot(xx - fx, yy - fy) / fr, ORB), mask))


def icon(small=False):
    img = Image.new("RGBA", (G, G), (0, 0, 0, 0))
    tile(img)
    back_windows(img, small)
    front_window(img, small)
    x0, y0, x1, y1 = FRONT
    strip = 70 if small else 58
    body_cy = (y0 + strip + y1) / 2
    orb(img, (x0 + x1) / 2, body_cy, 56 if small else 46)
    return img


def save(img, size, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.resize((size, size), Image.LANCZOS).save(path, optimize=True)
    print("wrote", path)


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    preview = sys.argv[sys.argv.index("--preview") + 1] if "--preview" in sys.argv else None
    icons = preview or os.path.join(root, "static", "icons")
    docs = preview or os.path.join(root, "docs", "images")
    big, small = icon(), icon(small=True)
    for size in (16, 32):
        save(small, size, os.path.join(icons, f"icon{size}.png"))
    for size in (48, 128):
        save(big, size, os.path.join(icons, f"icon{size}.png"))
    save(big, 512, os.path.join(docs, "icon.png"))


if __name__ == "__main__":
    main()
