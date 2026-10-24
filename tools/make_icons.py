"""Generate Orbita extension icons (pure stdlib PNG writer)."""
import struct
import zlib
from pathlib import Path
import math

OUT = Path(__file__).resolve().parent.parent / "extension" / "icons"
OUT.mkdir(parents=True, exist_ok=True)


def chunk(tag: bytes, data: bytes) -> bytes:
    return (struct.pack(">I", len(data)) + tag + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))


def write_png(path: Path, width: int, height: int, rgba_rows: bytes) -> None:
    raw = b"".join(b"\x00" + rgba_rows[y * width * 4:(y + 1) * width * 4]
                   for y in range(height))
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    path.write_bytes(png)


def lerp(a, b, t):
    return a + (b - a) * t


def sample(px, py, cx, cy, rx, ry, angle):
    """Signed distance-ish coverage of an ellipse ring, rotated."""
    c, s = math.cos(angle), math.sin(angle)
    dx, dy = px - cx, py - cy
    x = dx * c + dy * s
    y = -dx * s + dy * c
    if rx <= 0 or ry <= 0:
        return 0.0
    k = math.hypot(x / rx, y / ry)
    return k


def draw(size):
    ss = 4
    n = size * ss
    scale = size / 128.0
    cx = cy = (n - 1) / 2.0
    green_in = (34, 197, 94)
    green_out = (15, 118, 66)
    white = (245, 255, 250)
    pixels = bytearray(n * n * 4)
    disc = n * 0.47
    ring_w = n * 0.045 * max(1.0, 1.0)
    for py in range(n):
        for px in range(n):
            dx, dy = px - cx, py - cy
            d = math.hypot(dx, dy)
            t = min(1.0, d / disc)
            r = lerp(green_in[0], green_out[0], t)
            g = lerp(green_in[1], green_out[1], t)
            b = lerp(green_in[2], green_out[2], t)
            a = 1.0
            edge = disc - d
            if edge < 0:
                a = max(0.0, 1.0 + edge / (n * 0.02))
            # orbit ring (tilted ellipse, hollow)
            k = sample(px, py, cx, cy, disc * 0.92, disc * 0.42, -0.5)
            if 0.82 < k < 1.18:
                # keep only the back half visible: full ring is fine at this size
                r, g, b = white[0], white[1], white[2]
                a = 1.0
            # core planet
            core = math.hypot(dx, dy)
            if core < disc * 0.30:
                r, g, b = 250, 255, 252
                a = 1.0
            elif core < disc * 0.34:
                r, g, b = lerp(250, r, 0.5), lerp(255, g, 0.5), lerp(252, b, 0.5)
            # small moon on the ring
            ang = -0.5 + 1.15
            mx = cx + math.cos(ang) * disc * 0.92 * math.cos(-0.5) - 0
            my = cy + math.sin(ang) * disc * 0.42
            moon_r = disc * 0.13
            if math.hypot(px - mx, py - my) < moon_r:
                r, g, b = 255, 255, 255
                a = 1.0
            base = (py * n + px) * 4
            pixels[base] = int(r)
            pixels[base + 1] = int(g)
            pixels[base + 2] = int(b)
            pixels[base + 3] = int(max(0.0, min(1.0, a)) * 255)
    # downsample supersampled grid
    out = bytearray(size * size * 4)
    for y in range(size):
        for x in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(ss):
                for sx in range(ss):
                    base = ((y * ss + sy) * n + (x * ss + sx)) * 4
                    for ch in range(4):
                        acc[ch] += pixels[base + ch]
            div = ss * ss
            o = (y * size + x) * 4
            alpha = acc[3] / div
            for ch in range(3):
                out[o + ch] = int(acc[ch] / div) if alpha > 0 else 0
            out[o + 3] = int(alpha)
    return bytes(out)


for size in (16, 32, 48, 128):
    write_png(OUT / f"icon{size}.png", size, size, draw(size))
    print("wrote", size, "px")

svg = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
<defs><radialGradient id="g" cx="50%" cy="45%"><stop offset="0%" stop-color="#22c55e"/><stop offset="100%" stop-color="#0f7a44"/></radialGradient></defs>
<circle cx="64" cy="64" r="60" fill="url(#g)"/>
<ellipse cx="64" cy="64" rx="50" ry="22" fill="none" stroke="#f5fffa" stroke-width="5" transform="rotate(-28 64 64)"/>
<circle cx="64" cy="64" r="15" fill="#fafffb"/>
<circle cx="103" cy="38" r="7" fill="#ffffff"/>
</svg>
"""
(OUT / "icon.svg").write_text(svg, encoding="utf-8")
print("wrote icon.svg")
