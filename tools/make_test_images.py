#!/usr/bin/env python3
"""Generate test input images (all procedural, no third-party assets).

Usage: python3 tools/make_test_images.py
Outputs into ./tests/
"""
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "tests"
OUT.mkdir(exist_ok=True)


def make_synthetic(w, h, path):
    """Gradient sky + bright sun + dark foreground + gray ramp + color patches."""
    x = np.linspace(0, 1, w, dtype=np.float32)[None, :]
    y = np.linspace(0, 1, h, dtype=np.float32)[:, None]

    sky = np.stack([
        60 + 180 * x + 20 * (1 - y),
        90 + 150 * x + 15 * (1 - y),
        140 + 110 * x + 10 * (1 - y),
    ], axis=-1)
    sky = np.clip(sky + (40 * np.exp(-((y - 0.45) ** 2) / 0.01))[..., None], 0, 255)
    img = sky.astype(np.float32)

    fg = np.broadcast_to(y > 0.62, (h, w))
    texture = 18 + 25 * ((np.sin(x * 37) + np.cos(y * 53)) * 0.25 + 0.5)
    tex = np.stack([texture * 1.1, texture * 0.95, texture * 0.8], axis=-1)
    img[fg] = tex[fg]

    yy, xx = np.mgrid[0:h, 0:w]
    dist = np.sqrt((xx - w * 0.78) ** 2 + (yy - h * 0.18) ** 2)
    sun = np.clip(1 - dist / (min(w, h) * 0.085), 0, 1)[..., None]
    img = np.clip(img + sun * 255, 0, 255)

    py, ph = int(h * 0.70), max(2, int(h * 0.06))
    for gval in range(0, 256, 16):
        x0 = int(w * 0.04 + (gval / 255) * w * 0.44)
        img[py:py + ph, x0:x0 + max(2, int(w * 0.02))] = float(gval)

    pxx = int(w * 0.55)
    for i, (r, g, b) in enumerate([(220, 60, 50), (60, 180, 80), (50, 80, 210), (230, 180, 150), (255, 255, 255)]):
        x0 = pxx + i * int(w * 0.045)
        img[int(h * 0.72):int(h * 0.78), x0:x0 + max(2, int(w * 0.035))] = (r, g, b)

    Image.fromarray(img.astype(np.uint8)).save(path, quality=93, subsampling=0)
    print(f"wrote {path} ({w}x{h})")


def make_skin(w=1600, h=1200, path=None):
    """Portrait-like skin patch + highlight (for portrait protection tests)."""
    x = np.linspace(0, 1, w, dtype=np.float32)[None, :]
    y = np.linspace(0, 1, h, dtype=np.float32)[:, None]
    bg = np.stack([150 + 60 * x, 160 + 55 * x, 175 + 50 * x], axis=-1)
    img = bg.astype(np.float32)
    yy, xx = np.mgrid[0:h, 0:w]
    cx, cy = w * 0.5, h * 0.52
    r = min(w, h) * 0.34
    dist = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2) / r
    face = np.clip(1 - dist, 0, 1) ** 0.25
    skin = np.array([232, 190, 160], np.float32)
    img = img * (1 - face[..., None]) + skin * face[..., None]
    hi = np.clip(1 - np.sqrt((xx - w * 0.42) ** 2 + (yy - h * 0.38) ** 2) / (min(w, h) * 0.07), 0, 1) ** 0.7
    img = np.clip(img + hi[..., None] * 60, 0, 255)
    Image.fromarray(img.astype(np.uint8)).save(path, quality=93, subsampling=0)
    print(f"wrote {path} ({w}x{h})")


def main():
    make_synthetic(4000, 3000, OUT / "input_synthetic_12mp.jpg")
    make_synthetic(8000, 6000, OUT / "input_synthetic_48mp.jpg")
    make_skin(1600, 1200, OUT / "input_skin.jpg")


if __name__ == "__main__":
    main()
