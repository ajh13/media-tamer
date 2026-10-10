#!/usr/bin/env python3
"""Generate transparent PNG icons for Media Tamer extension.

No external dependencies — uses only struct + zlib (stdlib).

Produces theme-aware icon sets:
  - "dark" variant — dark strokes, for light toolbar themes (Firefox Light, Default)
  - "light" variant — light/white strokes, for dark toolbar themes (Firefox Dark, Alpenglow)

Design: bold play triangle (Option A), transparent background, maximized
silhouette. The triangle fills nearly the full slot — base near the left
edge, tip near the right edge, spanning almost the full vertical height.
No sound waves, no border, no tile, no sliders.

Each variant is rendered at 16, 32, 48, 96 px for full toolbar + Retina coverage.

Deterministic output: same input → identical PNG bytes (no timestamps).
"""
import struct
import zlib


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
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xffffffff)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", compressed) + chunk(b"IEND", b"")


def draw_icon(size, stroke):
    """Draw a bold play triangle using the given (r,g,b,255) stroke.

    The triangle maximizes the slot silhouette without cropping:
    - Base near the left edge, tip near the right edge
    - Spans nearly the full vertical height
    - No sound waves, no border, no extra elements
    """
    pixels = []
    CLEAR = (0, 0, 0, 0)

    # Triangle vertices (scaled to size)
    left_x = max(1, round(size * 0.0625))  # ~1px at 16x16
    top_y = 0
    bottom_y = size - 1
    tip_x = size - 1
    mid_y = size / 2.0

    if tip_x == left_x:
        # Degenerate case (shouldn't happen with our sizes)
        for y in range(size):
            for x in range(size):
                pixels.append(CLEAR)
        return pixels

    for y in range(size):
        for x in range(size):
            # Check if pixel is inside the play triangle
            if x < left_x or x > tip_x:
                pixels.append(CLEAR)
                continue

            # Calculate y boundaries at this x using linear interpolation
            t = (x - left_x) / (tip_x - left_x)
            y_top = top_y + (mid_y - top_y) * t
            y_bottom = bottom_y + (mid_y - bottom_y) * t

            if y_top <= y <= y_bottom:
                pixels.append(stroke)
            else:
                pixels.append(CLEAR)

    return pixels


# Colour definitions for each theme variant
VARIANTS = {
    # "dark" variant — dark strokes, used on LIGHT themes (Firefox Light / Default)
    "dark": (20, 20, 20, 255),
    # "light" variant — light strokes, used on DARK themes (Firefox Dark / Alpenglow)
    "light": (250, 250, 250, 255),
}

SIZES = [16, 32, 48, 96]

OUT_DIR = "extensions/media-tamer"

if __name__ == "__main__":
    import os

    for variant_name, colour in VARIANTS.items():
        for size in SIZES:
            pixels = draw_icon(size, colour)
            png = make_png(size, pixels)
            fname = os.path.join(OUT_DIR, f"icon-{size}-{variant_name}.png")
            with open(fname, "wb") as f:
                f.write(png)
            print(f"Generated {fname} ({len(png)} bytes, {size}x{size})")

    # Generate fallback icons (dark variant) for backward compatibility
    for size in [48, 96]:
        pixels = draw_icon(size, VARIANTS["dark"])
        png = make_png(size, pixels)
        fname = os.path.join(OUT_DIR, f"icon-{size}.png")
        with open(fname, "wb") as f:
            f.write(png)
        print(f"Generated {fname} ({len(png)} bytes, {size}x{size})")
