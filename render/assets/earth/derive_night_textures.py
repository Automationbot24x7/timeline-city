"""Rebuilds earth_night_south_asia.jpg from the NASA Black Marble 2016 tile C1 (see CREDITS.md for the URL and
checksum). Offline asset tool; the film never runs it.

  python derive_night_textures.py <dir with BlackMarble_2016_C1.jpg> [out dir]

Needs Pillow and numpy. Deterministic: same input, same pixels.

Besides the crop and resize, thin LINEAR light features in sparsely lit country are replaced by the land beside
them. At ~1 km VIIRS shows floodlit border fences (the India-Pakistan fence across the Thar and the Rann is a
bright wiggly line) as lines of light; the film must never draw a border, so every thin, isolated line of light
is treated alike, by shape alone (no boundary data is used): lit highways across empty desert go too. Points
(villages), blobs (towns, cities) and lines among dense lights (roads between villages) are kept; regional light
totals change by 2-10 %. The other textures are not rebuilt: in earth_night_8k.jpg (~5 km) the fence is a faint
sub-pixel line that the globe's light curve already drops (its brightest pixel maps to < 0.1 % of a city's), and
earth_night_delhi.jpg (the 3D city also reads it) shows no distinct fence line in its Punjab corner.
"""
import os
import sys

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
K = 0.55  # unlit land in these maps is blue: r ~ K * b (measured 0.41-0.62 in gamma space)


def lights(s):
    """Light above the blue land, from the red excess (gamma space; lights are warm/white)."""
    return np.clip((s[..., 0] - K * s[..., 2]) / (1 - 0.6 * K), 0, 1)


def box(x, r):
    """Mean over a (2r+1)^2 window (separable, edge-padded; float64 running sums)."""
    x = x.astype(np.float64)
    pad = ((r + 1, r), (0, 0)) + ((0, 0),) * (x.ndim - 2)
    c = np.cumsum(np.pad(x, pad, mode='edge'), 0)
    x = (c[2 * r + 1:] - c[:-2 * r - 1]) / (2 * r + 1)
    pad = ((0, 0), (r + 1, r)) + ((0, 0),) * (x.ndim - 2)
    c = np.cumsum(np.pad(x, pad, mode='edge'), 1)
    return ((c[:, 2 * r + 1:] - c[:, :-2 * r - 1]) / (2 * r + 1)).astype(np.float32)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def suppress(s, L, w, n=16, dens_r=15, dens=(0.035, 0.07)):
    """A pixel is on a thin line of light when, for some orientation, the samples along a segment of L px through
    it are lit (>= 35% of its own light) while the two parallel segments at +-w px are mostly unlit; points
    (villages: one lit sample along) and blobs (towns: lit sides) are not. Lines are only taken out in sparsely
    lit country (mean light within dens_r px below dens[0]; kept above dens[1]): there a lit line stands alone,
    while lit roads among dense villages and towns stay. The line (dilated 2 px, so the dark resampling ringing
    beside it goes too) is replaced by the unlit land around it (normalised blur)."""
    a = lights(s)
    H, W = a.shape
    h = L // 2
    P = h + w + 2
    thr = np.maximum(0.35 * a, 0.012)
    ap = np.pad(a, P)
    sh = lambda dx, dy: ap[P + dy:P + dy + H, P + dx:P + dx + W]
    best = np.full_like(a, -1.0)
    n_k = 2 * h + 1
    for i in range(n):
        th = np.pi * i / n
        c, sn = np.cos(th), np.sin(th)
        along = sum((sh(int(round(k * c)), int(round(k * sn))) >= thr).astype(np.float32) for k in range(-h, h + 1))
        side_p = sum((sh(int(round(k * c - w * sn)), int(round(k * sn + w * c))) >= thr).astype(np.float32) for k in range(-h, h + 1))
        side_m = sum((sh(int(round(k * c + w * sn)), int(round(k * sn - w * c))) >= thr).astype(np.float32) for k in range(-h, h + 1))
        np.maximum(best, (smoothstep(0.55, 0.85, along / n_k) * (1 - smoothstep(0.15, 0.4, np.maximum(side_p, side_m) / n_k))), out=best)
    m = best * smoothstep(0.02, 0.05, a) * (1 - smoothstep(dens[0], dens[1], box(a, dens_r)))
    mp = np.pad(m, 2)
    M = m.copy()
    for dy in range(-2, 3):
        for dx in range(-2, 3):
            if dx * dx + dy * dy <= 5:
                np.maximum(M, mp[2 + dy:2 + dy + H, 2 + dx:2 + dx + W], out=M)
    # the land around the line: unlit, unmasked pixels only (three box passes ~ a Gaussian)
    wgt = (1 - smoothstep(0.015, 0.06, a)) * (1 - M) + 1e-3
    blur = lambda x: box(box(box(x, 3), 3), 3)
    bg = blur(s * wgt[..., None]) / blur(wgt)[..., None]
    return np.clip(s + M[..., None] * (bg - s), 0, 1)


def suppress_strips(img, L, w, dens_r, rows=384):
    """suppress() over horizontal strips (bounded memory); identical to one pass over the whole image."""
    src = np.asarray(img.convert('RGB'))
    H = src.shape[0]
    P = L // 2 + w + 2 + dens_r + 2 + 9  # line test reach + density window + dilation + blur
    out = np.empty_like(src)
    for y0 in range(0, H, rows):
        a0, a1 = max(0, y0 - P), min(H, y0 + rows + P)
        s = src[a0:a1].astype(np.float32) / 255
        o = suppress(s, L, w, dens_r=dens_r)
        out[y0:min(H, y0 + rows)] = (o[y0 - a0:y0 - a0 + min(rows, H - y0)] * 255 + 0.5).astype(np.uint8)
    return Image.fromarray(out)


def main(src_dir, out_dir):
    # South Asia, 60-90 E x 5-37 N from tile C1 (0-90 E, 0-90 N, 240 px/deg), Lanczos 1/2 -> ~1 km/px
    c1 = Image.open(os.path.join(src_dir, 'BlackMarble_2016_C1.jpg'))
    sa = c1.crop((60 * 240, (90 - 37) * 240, 90 * 240, (90 - 5) * 240)).convert('RGB')
    del c1
    sa = sa.resize((3600, 3840), Image.LANCZOS)
    suppress_strips(sa, 15, 3, 15).save(os.path.join(out_dir, 'earth_night_south_asia.jpg'), quality=90)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else os.path.dirname(os.path.abspath(__file__)))
