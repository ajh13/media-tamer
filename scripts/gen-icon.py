#!/usr/bin/env python3
"""Generate polished transparent PNG icons for Media Tamer.

No external dependencies — uses only struct + zlib from the standard library.

Produces theme-aware icon sets:
  - "dark" variant — dark marks, for light toolbar themes (Firefox Light, Default)
  - "light" variant — light marks, for dark toolbar themes (Firefox Dark, Alpenglow)

Design: a compact media-control badge with a play triangle, volume bars, and a
small taming rail. The shapes stay bold enough for 16 px toolbar rendering while
128 px gives the AMO/listing icon a more finished brand mark.

Each variant is rendered at 16, 32, 48, 96, and 128 px for toolbar, Retina, and
store/listing coverage.

Deterministic output: same input → identical PNG bytes (no timestamps).
"""

import math
import os
import struct
import zlib


SIZES = [16, 32, 48, 96, 128]
OUT_DIR = "extensions/media-tamer"

# "dark" is shown on light browser chrome; "light" is shown on dark browser chrome.
VARIANTS = {
    "dark": {
        "primary": (17, 24, 39, 255),
        "accent": (37, 99, 235, 255),
        "secondary": (8, 47, 73, 255),
    },
    "light": {
        "primary": (248, 250, 252, 255),
        "accent": (125, 211, 252, 255),
        "secondary": (224, 242, 254, 255),
    },
}

CLEAR = (0, 0, 0, 0)


def make_png(size, pixels):
    """pixels: list of (r,g,b,a) tuples, row-major. Returns PNG bytes."""
    raw = b""
    for y in range(size):
        raw += b"\x00"  # filter byte
        for x in range(size):
            r, g, b, a = pixels[y * size + x]
            raw += bytes([r, g, b, a])
    compressed = zlib.compress(raw, 9)

    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", compressed) + chunk(b"IEND", b"")


def blend(over, under):
    """Alpha-compose two RGBA colours."""
    oa = over[3] / 255.0
    ua = under[3] / 255.0
    out_a = oa + ua * (1 - oa)
    if out_a == 0:
        return CLEAR
    out = []
    for i in range(3):
        out.append(round((over[i] * oa + under[i] * ua * (1 - oa)) / out_a))
    out.append(round(out_a * 255))
    return tuple(out)


def fill_rect(pixels, size, x0, y0, x1, y1, colour):
    for y in range(max(0, int(math.floor(y0))), min(size, int(math.ceil(y1)))):
        for x in range(max(0, int(math.floor(x0))), min(size, int(math.ceil(x1)))):
            pixels[y * size + x] = blend(colour, pixels[y * size + x])


def fill_circle(pixels, size, cx, cy, radius, colour):
    r2 = radius * radius
    for y in range(max(0, int(math.floor(cy - radius))), min(size, int(math.ceil(cy + radius + 1)))):
        for x in range(max(0, int(math.floor(cx - radius))), min(size, int(math.ceil(cx + radius + 1)))):
            if (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r2:
                pixels[y * size + x] = blend(colour, pixels[y * size + x])


def fill_capsule(pixels, size, x0, y0, x1, y1, colour):
    """Draw a horizontal rounded bar/capsule."""
    radius = max(0.5, (y1 - y0) / 2.0)
    fill_rect(pixels, size, x0 + radius, y0, x1 - radius, y1, colour)
    fill_circle(pixels, size, x0 + radius, (y0 + y1) / 2.0, radius, colour)
    fill_circle(pixels, size, x1 - radius, (y0 + y1) / 2.0, radius, colour)


def fill_vertical_capsule(pixels, size, x0, y0, x1, y1, colour):
    """Draw a vertical rounded bar/capsule."""
    radius = max(0.5, (x1 - x0) / 2.0)
    fill_rect(pixels, size, x0, y0 + radius, x1, y1 - radius, colour)
    fill_circle(pixels, size, (x0 + x1) / 2.0, y0 + radius, radius, colour)
    fill_circle(pixels, size, (x0 + x1) / 2.0, y1 - radius, radius, colour)


def point_in_triangle(px, py, a, b, c):
    """Return True when (px, py) is inside triangle abc."""
    def sign(p1, p2, p3):
        return (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1])

    p = (px, py)
    d1 = sign(p, a, b)
    d2 = sign(p, b, c)
    d3 = sign(p, c, a)
    has_neg = d1 < 0 or d2 < 0 or d3 < 0
    has_pos = d1 > 0 or d2 > 0 or d3 > 0
    return not (has_neg and has_pos)


def fill_triangle(pixels, size, a, b, c, colour):
    min_x = max(0, int(math.floor(min(a[0], b[0], c[0]))))
    max_x = min(size, int(math.ceil(max(a[0], b[0], c[0]) + 1)))
    min_y = max(0, int(math.floor(min(a[1], b[1], c[1]))))
    max_y = min(size, int(math.ceil(max(a[1], b[1], c[1]) + 1)))
    for y in range(min_y, max_y):
        for x in range(min_x, max_x):
            if point_in_triangle(x + 0.5, y + 0.5, a, b, c):
                pixels[y * size + x] = blend(colour, pixels[y * size + x])


def draw_icon(size, palette):
    pixels = [CLEAR for _ in range(size * size)]
    primary = palette["primary"]
    accent = palette["accent"]
    secondary = palette["secondary"]

    # A small top rail reads as a "tamer"/control cue at large sizes and as a
    # clean underline accent at toolbar sizes.
    rail_h = max(1, round(size * 0.08))
    fill_capsule(
        pixels,
        size,
        size * 0.14,
        size * 0.10,
        size * 0.86,
        size * 0.10 + rail_h,
        accent,
    )

    # Play triangle: the dominant silhouette.
    fill_triangle(
        pixels,
        size,
        (size * 0.18, size * 0.25),
        (size * 0.18, size * 0.78),
        (size * 0.56, size * 0.515),
        primary,
    )

    # Three volume/equalizer bars on the right; bold enough for 16 px.
    bar_w = max(1, round(size * 0.075))
    gap = max(1, round(size * 0.06))
    x0 = size * 0.58
    bottoms = size * 0.78
    heights = [size * 0.25, size * 0.42, size * 0.58]
    for idx, h in enumerate(heights):
        x = x0 + idx * (bar_w + gap)
        colour = accent if idx == 1 else secondary
        fill_vertical_capsule(pixels, size, x, bottoms - h, x + bar_w, bottoms, colour)

    # Anchor dot balances the play mark at larger sizes without cluttering 16 px.
    if size >= 32:
        fill_circle(pixels, size, size * 0.23, size * 0.83, max(1.0, size * 0.045), accent)

    return pixels


if __name__ == "__main__":
    for variant_name, palette in VARIANTS.items():
        for size in SIZES:
            pixels = draw_icon(size, palette)
            png = make_png(size, pixels)
            fname = os.path.join(OUT_DIR, f"icon-{size}-{variant_name}.png")
            with open(fname, "wb") as f:
                f.write(png)
            print(f"Generated {fname} ({len(png)} bytes, {size}x{size})")

    # Generate fallback icons (dark variant) for compatibility with older docs/tools.
    for size in [48, 96, 128]:
        pixels = draw_icon(size, VARIANTS["dark"])
        png = make_png(size, pixels)
        fname = os.path.join(OUT_DIR, f"icon-{size}.png")
        with open(fname, "wb") as f:
            f.write(png)
        print(f"Generated {fname} ({len(png)} bytes, {size}x{size})")
