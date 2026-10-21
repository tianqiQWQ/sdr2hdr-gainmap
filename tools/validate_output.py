#!/usr/bin/env python3
"""Structural + numerical validation for the Ultra HDR gain-map prototype output.

Modes:
  python3 validate_output.py --output tests/out.jpg --original tests/in.jpg \
      [--strength 50] [--gain-scale 1.0] [--dump DIR]
  python3 validate_output.py --decode path/to/reference-ultrahdr.jpg   (reference decoder check)
"""
import argparse
import io
import json
import re
import struct
import sys
from pathlib import Path

import numpy as np
from PIL import Image

# 与 index.html 中保持一致的合成参数
KNEE = 150.0
CURVE_POW = 1.6
MAXC_WEIGHT = 0.85
DETAIL_WEIGHT = 0.55
DETAIL_RADIUS = 16.0

XMP_ID = b"http://ns.adobe.com/xap/1.0/\x00"
EXIF_ID = b"Exif\x00\x00"
ICC_ID = b"ICC_PROFILE\x00"
MPF_ID = b"MPF\x00"


# ---------------------------------------------------------------- JPEG parsing
def parse_segments(data: bytes):
    """Top-level JPEG segments of the primary image (stops after SOS)."""
    if data[0:2] != b"\xff\xd8":
        raise ValueError("not jpeg")
    segs = []
    i = 2
    n = len(data)
    while i < n - 1:
        if data[i] != 0xFF:
            raise ValueError(f"expected marker at {i}")
        marker = data[i + 1]
        if marker == 0xD9:
            segs.append(dict(marker=marker, start=i, end=i + 2,
                             payload_start=i + 2, payload_end=i + 2))
            break
        if marker == 0xDA:
            ln = struct.unpack(">H", data[i + 2:i + 4])[0]
            segs.append(dict(marker=marker, start=i, end=i + 2 + ln,
                             payload_start=i + 4, payload_end=i + 2 + ln))
            break
        if marker == 0xD8 or 0xD0 <= marker <= 0xD7 or marker == 0x01:
            i += 2
            continue
        ln = struct.unpack(">H", data[i + 2:i + 4])[0]
        if ln < 2 or i + 2 + ln > n:
            raise ValueError(f"bad segment length at {i}")
        segs.append(dict(marker=marker, start=i, end=i + 2 + ln,
                         payload_start=i + 4, payload_end=i + 2 + ln))
        i += 2 + ln
    return segs


def find_insert_pos(data: bytes):
    pos = 2
    while pos + 4 <= len(data):
        if data[pos] != 0xFF:
            break
        m = data[pos + 1]
        if 0xE0 <= m <= 0xEF:
            ln = struct.unpack(">H", data[pos + 2:pos + 4])[0]
            pos += 2 + ln
        else:
            break
    return pos


def get_segment_payload(data: bytes, marker: int, ident: bytes):
    for s in parse_segments(data):
        if s["marker"] == marker:
            p = data[s["payload_start"]:s["payload_end"]]
            if p.startswith(ident):
                return p
    return None


def strip_stale_hdr(data: bytes):
    """Remove stale MPF segments and hdrgm XMP (same policy as prototype)."""
    removed = {"mpf": 0, "xmp": 0}
    kept = []
    pos = 2
    while pos + 4 <= len(data):
        if data[pos] != 0xFF:
            break
        m = data[pos + 1]
        if not (0xE0 <= m <= 0xEF):
            break
        ln = struct.unpack(">H", data[pos + 2:pos + 4])[0]
        if ln < 2 or pos + 2 + ln > len(data):
            break
        payload = data[pos + 4:pos + 2 + ln]
        drop = False
        if m == 0xE2 and payload.startswith(MPF_ID):
            drop = True
            removed["mpf"] += 1
        elif m == 0xE1 and payload.startswith(XMP_ID):
            txt = payload.decode("utf-8", "ignore")
            if "hdrgm:" in txt:
                drop = True
                removed["xmp"] += 1
        if not drop:
            kept.append(data[pos:pos + 2 + ln])
        pos += 2 + ln
    return data[:2] + b"".join(kept) + data[pos:], removed


# --------------------------------------------------------------------- MPF
def parse_mpf(data: bytes):
    mpf_payload = None
    mpf_abs = None
    for s in parse_segments(data):
        if s["marker"] == 0xE2:
            p = data[s["payload_start"]:s["payload_end"]]
            if p.startswith(MPF_ID):
                mpf_payload = p[4:]
                mpf_abs = s["payload_start"] + 4
                break
    if mpf_payload is None:
        raise ValueError("MPF not found")
    tiff = mpf_payload
    assert tiff[0:2] in (b"II", b"MM")
    bo = "<" if tiff[0:2] == b"II" else ">"
    magic, ifd0 = struct.unpack(bo + "HI", tiff[2:8])
    assert magic == 42

    def read_ifd(off):
        cnt = struct.unpack(bo + "H", tiff[off:off + 2])[0]
        p = off + 2
        entries = []
        for _ in range(cnt):
            tag, typ, count = struct.unpack(bo + "HHI", tiff[p:p + 8])
            val = tiff[p + 8:p + 12]
            entries.append((tag, typ, count, val))
            p += 12
        nxt = struct.unpack(bo + "I", tiff[p:p + 4])[0]
        return entries, nxt

    entries, nxt = read_ifd(ifd0)
    if not any(t == 0xB002 for t, _, _, _ in entries):
        entries, _ = read_ifd(nxt)
    tags = {t: (ty, c, v) for t, ty, c, v in entries}
    ty, cnt, val = tags[0xB002]
    off = struct.unpack(bo + "I", val)[0]
    raw = tiff[off:off + cnt]
    imgs = []
    for k in range(0, len(raw), 16):
        attr, size, doff = struct.unpack(bo + "III", raw[k:k + 12])
        imgs.append(dict(attr=attr, size=size, data_offset=doff))
    images = []
    for idx, im in enumerate(imgs):
        abs_off = 0 if (idx == 0 and im["data_offset"] == 0) else mpf_abs + im["data_offset"]
        images.append(dict(**im, abs_offset=abs_off))
    return dict(tiff_abs=mpf_abs, images=images)


# --------------------------------------------------------------------- XMP
def xmp_blocks(data: bytes):
    out = []
    for s in parse_segments(data):
        if s["marker"] == 0xE1:
            p = data[s["payload_start"]:s["payload_end"]]
            if p.startswith(XMP_ID):
                out.append(p[len(XMP_ID):].decode("utf-8", "replace"))
    return out


def parse_hdrgm(xmp: str):
    meta = {}
    for k in ("Version", "BaseRenditionIsHDR", "GainMapMin", "GainMapMax", "Gamma",
              "OffsetSDR", "OffsetHDR", "HDRCapacityMin", "HDRCapacityMax"):
        m = re.search(rf'hdrgm:{k}="([^"]*)"', xmp)
        if m:
            meta[k] = m.group(1)
    if "GainMapMax" not in meta:  # rdf:Seq 形式（Adobe 多通道）
        for k in ("GainMapMin", "GainMapMax", "Gamma"):
            block = re.search(rf"<hdrgm:{k}>\s*<rdf:Seq>(.*?)</rdf:Seq>", xmp, re.S)
            if block:
                meta[k] = re.findall(r"<rdf:li>([^<]*)</rdf:li>", block.group(1))
        for k in ("Version", "OffsetSDR", "OffsetHDR", "HDRCapacityMin", "HDRCapacityMax",
                  "BaseRenditionIsHDR"):
            m = re.search(rf'hdrgm:{k}="([^"]*)"', xmp)
            if m:
                meta[k] = m.group(1)
    return meta


def first_meta(v, default=None):
    if isinstance(v, list):
        return float(v[0]) if v else default
    return default if v is None else float(v)


def container_length(xmp: str):
    m = re.search(r'Item:Semantic="GainMap"[^>]*Item:Length="(\d+)"', xmp)
    return int(m.group(1)) if m else None


# ------------------------------------------------------------------ decoding
def srgb_inv(x):
    x = np.asarray(x, dtype=np.float64)
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)


def srgb_fwd(x):
    x = np.clip(x, 0, 1)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * x ** (1 / 2.4) - 0.055)


def box_blur_np(a, rad):
    """Separable box blur with edge padding (numpy float32)."""
    rad = int(max(1, rad))
    win = 2 * rad + 1
    pad = np.pad(a, ((0, 0), (rad, rad)), mode="edge")
    cs = np.concatenate([np.zeros((pad.shape[0], 1), np.float32),
                         np.cumsum(pad, axis=1, dtype=np.float32)], axis=1)
    h = (cs[:, win:win + a.shape[1]] - cs[:, :a.shape[1]]) / win
    pad2 = np.pad(h, ((rad, rad), (0, 0)), mode="edge")
    cs2 = np.concatenate([np.zeros((1, pad2.shape[1]), np.float32),
                          np.cumsum(pad2, axis=0, dtype=np.float32)], axis=0)
    return (cs2[win:win + a.shape[0], :] - cs2[:a.shape[0], :]) / win


def to_channels(meta_val, default):
    if isinstance(meta_val, list):
        return [float(v) for v in meta_val]
    return [float(meta_val if meta_val is not None else default)] * 3


def decode_gainmap_meta(meta):
    multichannel = isinstance(meta.get("GainMapMax"), list)
    if multichannel:
        return dict(
            mins=to_channels(meta.get("GainMapMin", "0"), 0),
            maxs=to_channels(meta.get("GainMapMax", "1"), 1),
            gammas=to_channels(meta.get("Gamma", "1"), 1),
            off_sdr=to_channels(meta.get("OffsetSDR", "0"), 0),
            off_hdr=to_channels(meta.get("OffsetHDR", "0"), 0),
        )
    return dict(
        mins=[float(meta.get("GainMapMin", "0"))] * 3,
        maxs=[float(meta.get("GainMapMax", "1"))] * 3,
        gammas=[float(meta.get("Gamma", "1"))] * 3,
        off_sdr=[float(meta.get("OffsetSDR", "0"))] * 3,
        off_hdr=[float(meta.get("OffsetHDR", "0"))] * 3,
    )


def reconstruct_hdr(base_img: Image.Image, gm_img: Image.Image, meta: dict):
    """Returns hdr_linear (H,W,3) and boost (H,W,3), assuming full display headroom."""
    base = np.asarray(base_img.convert("RGB"), dtype=np.float64) / 255.0
    base_lin = srgb_inv(base)
    gm_img = gm_img.convert("RGB")
    if gm_img.size != base_img.size:
        gm_img = gm_img.resize(base_img.size, Image.BILINEAR)
    gm = np.asarray(gm_img, dtype=np.float64) / 255.0
    md = decode_gainmap_meta(meta)
    hdr = np.zeros_like(base_lin)
    boost = np.zeros_like(base_lin)
    for c in range(3):
        g = np.clip(gm[..., c], 0, 1)
        if md["gammas"][c] != 1.0:
            g = np.power(g, 1.0 / md["gammas"][c])
        log_boost = md["mins"][c] * (1 - g) + md["maxs"][c] * g
        b = np.exp2(log_boost)
        hdr[..., c] = (base_lin[..., c] + md["off_sdr"][c]) * b - md["off_hdr"][c]
        boost[..., c] = b
    return hdr, boost


def tonemap_preview(hdr_lin, peak):
    x = np.clip(hdr_lin, 0, None)
    out = (2 * x) / (x + peak)
    return (srgb_fwd(np.clip(out, 0, 1)) * 255).astype(np.uint8)


# -------------------------------------------------------------------- checks
class Checker:
    def __init__(self):
        self.failures = 0

    def check(self, cond, msg, detail=""):
        tag = "PASS" if cond else "FAIL"
        print(f"  [{tag}] {msg}" + (f"  ({detail})" if detail else ""))
        if not cond:
            self.failures += 1
        return cond


def decode_reference(path: Path, dump_dir: Path):
    data = path.read_bytes()
    print(f"=== reference decode: {path} ({len(data)} bytes) ===")
    mpf = parse_mpf(data)
    print(f"MPF: tiff_abs={mpf['tiff_abs']} images="
          f"{[(hex(i['attr']), i['size'], i['abs_offset']) for i in mpf['images']]}")
    primary = data[mpf["images"][0]["abs_offset"]:mpf["images"][0]["abs_offset"] + mpf["images"][0]["size"]]
    secondary = data[mpf["images"][1]["abs_offset"]:mpf["images"][1]["abs_offset"] + mpf["images"][1]["size"]]
    base = Image.open(io.BytesIO(primary))
    gm = Image.open(io.BytesIO(secondary))
    print(f"primary {base.size} {base.mode}, gain map {gm.size} {gm.mode}")
    meta = {}
    for x in xmp_blocks(secondary):
        m = parse_hdrgm(x)
        if m.get("GainMapMax"):
            meta = m
            break
    if not meta:
        for x in xmp_blocks(primary):
            m = parse_hdrgm(x)
            if m.get("GainMapMax"):
                meta = m
                break
    print("hdrgm:", json.dumps(meta, ensure_ascii=False, indent=2))
    if not meta:
        print("no hdrgm metadata found")
        return 2
    hdr, boost = reconstruct_hdr(base, gm, meta)
    print(f"boost: min={boost.min():.4f} max={boost.max():.4f} p99={np.percentile(boost, 99):.3f}")
    if dump_dir:
        dump_dir.mkdir(parents=True, exist_ok=True)
        Image.fromarray(tonemap_preview(hdr, float(boost.max()))).save(dump_dir / "reference_hdr_tonemapped.png")
        gm.convert("L").save(dump_dir / "reference_gainmap.png")
        print(f"dumped to {dump_dir}")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--output")
    ap.add_argument("--original")
    ap.add_argument("--decode")
    ap.add_argument("--strength", type=float, default=50)
    ap.add_argument("--gain-scale", type=float, default=1.0,
                    help="gain map resolution relative to primary")
    ap.add_argument("--knee", type=float, default=170)
    ap.add_argument("--pow", type=float, default=1.6, help="curve exponent")
    ap.add_argument("--detail", type=float, default=40, help="detail boost percent")
    ap.add_argument("--color", type=float, default=85, help="color highlight weight percent")
    ap.add_argument("--detail-radius", type=float, default=16, help="detail radius in image px")
    ap.add_argument("--clarity", type=float, default=15, help="local contrast percent")
    ap.add_argument("--base-reencoded", action="store_true", help="input was re-encoded into JPEG base (e.g. PNG)")
    ap.add_argument("--exposure-ev", type=float, default=0.0, help="overall exposure lift in EV")
    ap.add_argument("--highlight-compress", type=float, default=80.0, help="highlight rolloff percent")
    ap.add_argument("--dump")
    args = ap.parse_args()

    if args.decode:
        return decode_reference(Path(args.decode), Path(args.dump) if args.dump else None)

    if not (args.output and args.original):
        ap.error("need --output and --original (or --decode)")

    out_path = Path(args.output)
    orig_path = Path(args.original)
    out = out_path.read_bytes()
    orig = orig_path.read_bytes()
    ck = Checker()
    dump = Path(args.dump) if args.dump else None
    if dump:
        dump.mkdir(parents=True, exist_ok=True)

    strength = args.strength / 100.0
    expected_M = 3.0 * strength
    exposure_ev = args.exposure_ev
    exposure_mode = exposure_ev > 0.001
    F_exp = 2.0 ** exposure_ev if exposure_mode else 1.0
    comp = args.highlight_compress / 100.0

    def tone_exp(z, compress):
        t = 0.15
        z = np.asarray(z, np.float64)
        out = np.where(z <= t, z, t + (1 - t) * (1 - np.exp(-(z - t) / (1 - t) * 0.25)))
        if compress < 1:
            out = (1 - compress) * np.minimum(z, 1) + compress * out
        return out

    if exposure_mode:
        zd_max = float(tone_exp(F_exp, comp))
        expected_M = expected_M + float(np.log2(F_exp / max(zd_max, 1e-6))) + 0.05
        print(f"    exposure mode: EV={exposure_ev:+.2f}, F={F_exp:.2f}, compress={args.highlight_compress:.0f}%, "
              f"expected gain range 0..{expected_M:.3f} stops")

    print(f"=== validate {out_path.name} vs {orig_path.name} "
          f"(strength={args.strength}, gain_scale={args.gain_scale}, expected max={expected_M:.3f} stops) ===")
    print(f"    params: knee={args.knee} pow={args.pow} detail={args.detail}% color={args.color}% "
          f"radius={args.detail_radius}px clarity={args.clarity}%")

    # ---------------- [1] container structure ----------------
    print("\n[1] container structure")
    mpf_segs = [s for s in parse_segments(out)
                if s["marker"] == 0xE2 and out[s["payload_start"]:s["payload_end"]].startswith(MPF_ID)]
    ck.check(len(mpf_segs) == 1, "exactly one MPF segment in primary", f"found {len(mpf_segs)}")
    mpf = parse_mpf(out)
    ck.check(len(mpf["images"]) == 2, "MPF has 2 images")
    imgs = mpf["images"]
    primary_size, secondary_size = imgs[0]["size"], imgs[1]["size"]
    ck.check(imgs[0]["abs_offset"] == 0, "primary image starts at file offset 0")
    ck.check(imgs[1]["abs_offset"] == primary_size,
             "secondary (gain map) begins right after primary",
             f"{imgs[1]['abs_offset']} == {primary_size}")
    ck.check(primary_size + secondary_size == len(out), "primary+secondary size == file size",
             f"{primary_size}+{secondary_size} vs {len(out)}")
    secondary = out[imgs[1]["abs_offset"]:imgs[1]["abs_offset"] + secondary_size]
    ck.check(secondary[:2] == b"\xff\xd8" and secondary[-2:] == b"\xff\xd9",
             "gain map image is a complete JPEG (SOI..EOI)")
    ck.check(out[-2:] == b"\xff\xd9", "file ends with EOI")
    ck.check(imgs[1]["data_offset"] == primary_size - mpf["tiff_abs"],
             "MPF secondary data offset is consistent with TIFF header",
             f"{imgs[1]['data_offset']} == {primary_size} - {mpf['tiff_abs']}")

    # ---------------- [2] metadata ----------------
    print("\n[2] metadata")
    xmp_primary_all = xmp_blocks(out[:primary_size])
    ck.check(sum(1 for x in xmp_primary_all if "Container:Directory" in x) == 1,
             "exactly one gain-map container XMP in primary")
    primary_xmp = next((x for x in xmp_primary_all if "Container:Directory" in x), None)
    ck.check(primary_xmp is not None, "primary XMP with GContainer present")
    sec_xmp = next((x for x in xmp_blocks(secondary) if parse_hdrgm(x).get("GainMapMax")), None)
    ck.check(sec_xmp is not None, "gain map image XMP with hdrgm metadata present")
    meta = parse_hdrgm(sec_xmp) if sec_xmp else {}
    print("    hdrgm:", json.dumps(meta, ensure_ascii=False))
    ck.check(meta.get("BaseRenditionIsHDR") == "False", "BaseRenditionIsHDR=False")
    ck.check(abs(first_meta(meta.get("GainMapMax"), -1) - expected_M) < 1e-6,
             "GainMapMax == expected stops",
             f"{meta.get('GainMapMax')} vs {expected_M:.3f}")
    ck.check(first_meta(meta.get("GainMapMin"), 1) == 0.0, "GainMapMin == 0")
    ck.check(first_meta(meta.get("Gamma"), 0) == 1.0, "Gamma == 1")
    if sec_xmp:
        ck.check("<hdrgm:GainMapMax>" in sec_xmp and "<rdf:Seq>" in sec_xmp,
                 "secondary XMP uses Adobe-style rdf:Seq channel list")
    ck.check(abs(float(meta.get("HDRCapacityMax", -1)) - expected_M) < 1e-6,
             "HDRCapacityMax == GainMapMax")
    if primary_xmp:
        L = container_length(primary_xmp)
        ck.check(L == secondary_size, "GContainer Item:Length == secondary size",
                 f"{L} vs {secondary_size}")

    # ---------------- [3] base bytes / metadata ----------------
    orig_clean, removed = strip_stale_hdr(orig)
    orig_exif = None
    try:
        for _s in parse_segments(orig):
            if _s["marker"] == 0xE1:
                _p = orig[_s["payload_start"]:_s["payload_end"]]
                if _p.startswith(EXIF_ID):
                    orig_exif = _p
                    break
    except Exception:
        orig_exif = None  # 非 JPEG 输入（如 PNG）
    if exposure_mode or args.base_reencoded:
        print("\n[3] base re-encoded (exposure / non-JPEG input), metadata preservation")
        if exposure_mode and not args.base_reencoded and orig_exif is not None:
            ck.check(get_segment_payload(out, 0xE1, EXIF_ID) == orig_exif,
                     "EXIF segment preserved after base re-encode")
        ck.check(sum(1 for x in xmp_primary_all if "hdrgm:" in x) == 1,
                 "no leftover stale hdrgm XMP in primary")
        print("    (byte-identity of SDR base is intentionally skipped)")
    else:
        # ---------------- [3] original bytes preserved ----------------
        print("\n[3] original bytes preserved")
        orig_clean, removed = strip_stale_hdr(orig)
        if removed["mpf"] or removed["xmp"]:
            print(f"    (input had stale HDR metadata: MPF x{removed['mpf']}, "
                  f"XMP x{removed['xmp']}; comparing against cleaned input)")
        ins = find_insert_pos(orig_clean)
        ck.check(out[:ins] == orig_clean[:ins], "original bytes before insertion point unchanged",
                 f"{ins} bytes")
        ck.check(out[primary_size - (len(orig_clean) - ins):primary_size] == orig_clean[ins:],
                 "original bytes after insertion point unchanged",
                 f"{len(orig_clean) - ins} bytes")
        orig_exif = None
        for s in parse_segments(orig):
            if s["marker"] == 0xE1:
                p = orig[s["payload_start"]:s["payload_end"]]
                if p.startswith(EXIF_ID):
                    orig_exif = p
                    break
        if orig_exif is not None:
            ck.check(get_segment_payload(out, 0xE1, EXIF_ID) == orig_exif,
                     "EXIF segment preserved byte-exactly")
        ck.check(sum(1 for x in xmp_primary_all if "hdrgm:" in x) == 1,
                 "no leftover stale hdrgm XMP in primary")

    # ---------------- [4] pixels / HDR reconstruction ----------------
    if exposure_mode:
        print("\n[4] pixels / HDR reconstruction (exposure mode)")
        base = Image.open(io.BytesIO(out[:primary_size]))
        gm = Image.open(io.BytesIO(secondary))
        orig_img = Image.open(io.BytesIO(orig)).convert("RGB")
        W, H = base.size
        exp_w = max(1, round(W * args.gain_scale))
        exp_h = max(1, round(H * args.gain_scale))
        ck.check(abs(gm.size[0] - exp_w) <= 1 and abs(gm.size[1] - exp_h) <= 1,
                 "gain map dimensions match selected resolution",
                 f"{gm.size} vs {(exp_w, exp_h)}")
        a_base = np.asarray(base.convert("RGB"), np.float32)
        a_orig = np.asarray(orig_img.resize(base.size, Image.BILINEAR), np.float32)
        ck.check(not np.array_equal(a_base.astype(np.uint8), a_orig.astype(np.uint8)),
                 "SDR base was re-encoded (exposure mode)")

        # 期望的曝光底图
        x = srgb_inv(a_orig.astype(np.float64) / 255.0)
        Y = 0.2126 * x[..., 0] + 0.7152 * x[..., 1] + 0.0722 * x[..., 2]
        z = Y * F_exp
        zd = tone_exp(z, comp)
        scale = np.where(z > 1e-7, zd / np.maximum(z, 1e-7), 0.0)
        exp_base = (srgb_fwd(np.clip(x * F_exp * scale[..., None], 0, 1)) * 255.0).round()
        dbase = np.abs(a_base.astype(np.float64) - exp_base)
        ck.check(float(np.median(dbase)) < 12,
                 "SDR base matches exposure tone-map",
                 f"median {float(np.median(dbase)):.2f}, p90 {float(np.percentile(dbase, 90)):.2f}")

        Lb = (0.2126 * srgb_inv(a_base[..., 0] / 255.0)
              + 0.7152 * srgb_inv(a_base[..., 1] / 255.0)
              + 0.0722 * srgb_inv(a_base[..., 2] / 255.0))
        dark = (Y > 1e-4) & (Y < 0.01)
        lift = float(np.median(Lb[dark] / Y[dark])) if dark.sum() > 500 else float("nan")
        ck.check(dark.sum() > 500 and 0.7 * F_exp <= lift <= 1.3 * F_exp,
                 "dark background lifted by ~2^EV",
                 f"median lift {lift:.2f} vs {F_exp:.2f}")

        # 校验尺度
        check_scale = 1.0
        while W * H * check_scale * check_scale > 25e6 and check_scale > 0.1:
            check_scale *= 0.5
        if check_scale < 1.0:
            cw, ch = max(1, round(W * check_scale)), max(1, round(H * check_scale))
            base_c = base.convert("RGB").resize((cw, ch), Image.BILINEAR)
            orig_c = orig_img.resize((cw, ch), Image.BILINEAR)
            print(f"    (pixel checks use {cw}x{ch} for memory)")
        else:
            base_c = base.convert("RGB")
            orig_c = orig_img
        gm_c = gm.convert("L").resize(base_c.size, Image.BILINEAR)
        gm_vals = np.asarray(gm_c, np.float32) / 255.0

        # 期望增益图（原始像素算启发式 + 曝光恢复项）
        b = np.asarray(orig_c, np.float32)
        lum = (54.0 * b[..., 0] + 183.0 * b[..., 1] + 19.0 * b[..., 2]) / 256.0
        maxc = b.max(axis=2)
        xb = srgb_inv(b.astype(np.float64) / 255.0)
        Yc = 0.2126 * xb[..., 0] + 0.7152 * xb[..., 1] + 0.0722 * xb[..., 2]
        base_metric = np.maximum(lum, (args.color / 100.0) * maxc)
        rad_d = max(2, int(round(args.detail_radius * check_scale)))
        rad_c = max(3, int(round(max(24.0, args.detail_radius * 4.0) * check_scale)))
        detail = lum - box_blur_np(lum, rad_d)
        clarity = lum - box_blur_np(lum, rad_c)
        metric = np.minimum(
            255.0,
            base_metric
            + (args.detail / 100.0) * np.maximum(detail, 0)
            + (args.clarity / 100.0) * np.maximum(clarity, 0),
        )
        g_heur = np.clip((metric - args.knee) / (255.0 - args.knee), 0, 1) ** args.pow
        M_val = 3.0 * (args.strength / 100.0)
        zc = Yc * F_exp
        zdc = tone_exp(zc, comp)
        recover = np.where(zdc > 1e-7, np.log2(np.maximum(zc, 1e-7) / np.maximum(zdc, 1e-7)), 0.0)
        g_exp = np.clip((M_val * g_heur + recover) / expected_M, 0, 1)
        dg = np.abs(gm_vals - g_exp)
        ck.check(float(np.median(dg)) < 0.08,
                 "gain map follows exposure synthesis curve",
                 f"median {float(np.median(dg)):.4f}, p95 {float(np.percentile(dg, 95)):.4f}")
        ck.check(float(np.percentile(dg, 95)) < 0.25,
                 "gain map 95th-percentile deviation",
                 f"{float(np.percentile(dg, 95)):.4f}")

        # HDR 重建检查
        hdr, boost = reconstruct_hdr(base_c, gm_c, meta)
        Yh = 0.2126 * hdr[..., 0] + 0.7152 * hdr[..., 1] + 0.0722 * hdr[..., 2]
        dark_c = (Yc > 1e-4) & (Yc < 0.01)
        if dark_c.sum() > 500:
            ratio = float(np.median(Yh[dark_c] / (Yc[dark_c] * F_exp)))
            ck.check(0.7 <= ratio <= 1.3, "HDR shadows ~= SDR original x 2^EV",
                     f"median ratio {ratio:.2f}")
        bright = Yc > 0.3
        if bright.sum() > 500:
            boosted = float(np.median(Yh[bright] / Yc[bright]))
            ck.check(boosted > 1.5, "HDR highlights lifted above original",
                     f"median {boosted:.2f}x")
        bmean = boost.mean(axis=2)
        bmax = 2 ** expected_M
        print(f"    gain map range 0..{expected_M:.2f} stops; HDR linear luma max {float(Yh.max()):.2f}")
    else:
        # ---------------- [4] pixels / HDR reconstruction ----------------
        print("\n[4] pixels / HDR reconstruction")
        base = Image.open(io.BytesIO(out[:primary_size]))
        base_orig = Image.open(io.BytesIO(orig))
        a1 = np.asarray(base.convert("RGB"))
        a0 = np.asarray(base_orig.convert("RGB"))
        ck.check(a1.shape == a0.shape, "SDR base dimensions equal original")
        if args.base_reencoded:
            dd = np.abs(a1.astype(np.int16) - a0.astype(np.int16))
            ck.check(float(np.median(dd)) < 6,
                     "SDR base close to original (re-encoded)",
                     f"median {float(np.median(dd)):.2f}, p90 {float(np.percentile(dd, 90)):.2f}")
        else:
            ck.check(np.array_equal(a1, a0), "SDR base pixels identical to original")
        gm = Image.open(io.BytesIO(secondary))
        W, H = base.size
        exp_w = max(1, round(W * args.gain_scale))
        exp_h = max(1, round(H * args.gain_scale))
        ck.check(abs(gm.size[0] - exp_w) <= 1 and abs(gm.size[1] - exp_h) <= 1,
                 "gain map dimensions match selected resolution",
                 f"{gm.size} vs {(exp_w, exp_h)}")

        # 校验尺度：超过 2500 万像素时降采样，控制内存
        check_scale = 1.0
        while W * H * check_scale * check_scale > 25e6 and check_scale > 0.1:
            check_scale *= 0.5
        if check_scale < 1.0:
            cw, ch = max(1, round(W * check_scale)), max(1, round(H * check_scale))
            base_c = base.convert("RGB").resize((cw, ch), Image.BILINEAR)
            print(f"    (pixel checks use {cw}x{ch} for memory)")
        else:
            base_c = base.convert("RGB")
        gm_c = gm.convert("L").resize(base_c.size, Image.BILINEAR)
        gm_vals = np.asarray(gm_c, dtype=np.float32) / 255.0

        # 用合成曲线核对增益图（细节项在降采样后不完全等价，只做统计检查）
        b = np.asarray(base_c, dtype=np.float32)
        lum = (54.0 * b[..., 0] + 183.0 * b[..., 1] + 19.0 * b[..., 2]) / 256.0
        maxc = b.max(axis=2)
        base_metric = np.maximum(lum, (args.color / 100.0) * maxc)
        rad_d = max(2, int(round(args.detail_radius * check_scale)))
        rad_c = max(3, int(round(max(24.0, args.detail_radius * 4.0) * check_scale)))
        detail = lum - box_blur_np(lum, rad_d)
        clarity = lum - box_blur_np(lum, rad_c)
        metric = np.minimum(
            255.0,
            base_metric
            + (args.detail / 100.0) * np.maximum(detail, 0)
            + (args.clarity / 100.0) * np.maximum(clarity, 0),
        )
        g_exp = np.clip((metric - args.knee) / (255.0 - args.knee), 0, 1) ** args.pow
        g_base = np.clip((base_metric - args.knee) / (255.0 - args.knee), 0, 1) ** args.pow
        diff = np.abs(gm_vals - g_exp)
        ck.check(float(np.median(diff)) < 0.08,
                 "gain map median deviation from synthesis curve",
                 f"median {float(np.median(diff)):.4f}, p95 {float(np.percentile(diff, 95)):.4f}")
        ck.check(float(np.percentile(diff, 95)) < 0.25,
                 "gain map 95th-percentile deviation from synthesis curve",
                 f"{float(np.percentile(diff, 95)):.4f}")
        detail_frac = float(np.mean(gm_vals > g_base + 0.05))
        print(f"    small-detail boost active on {detail_frac * 100:.2f}% of pixels")

        hdr, boost = reconstruct_hdr(base_c, gm_c, meta)
        bmean = boost.mean(axis=2)
        bmax = 2 ** expected_M
        white = metric >= 254
        if white.sum() > 200:
            ck.check(0.65 * bmax <= float(np.median(bmean[white])) <= 1.10 * bmax,
                     "clipped whites boosted toward 2^GainMapMax",
                     f"median {float(np.median(bmean[white])):.3f} vs {bmax:.3f}")
        else:
            print("    (image has no clipped whites; partial boost is expected)")
        dark = base_metric <= 120
        if dark.sum() > 50:
            ck.check(np.median(bmean[dark]) < 1.05, "dark/mid pixels essentially unchanged",
                     f"median {float(np.median(bmean[dark])):.4f}")
        bins = []
        for lo in range(0, 256, 32):
            m = (base_metric >= lo) & (base_metric < lo + 32)
            if m.sum() > 100:
                bins.append((lo, float(np.median(bmean[m]))))
        print("    boost by brightness metric:", ", ".join(f"{lo}-{lo+31}:{bb:.3f}" for lo, bb in bins))
        vals = [bb for _, bb in bins]
        ck.check(all(vals[i] <= vals[i + 1] + 1e-3 for i in range(len(vals) - 1)),
                 "boost increases monotonically with brightness metric")
        if expected_M < 1e-6:
            ck.check(float(np.max(np.abs(hdr - srgb_inv(np.asarray(base_c, dtype=np.float64) / 255.0)))) < 1e-3,
                     "strength 0 -> HDR equals SDR base (identity)")

    # ---------------- dumps ----------------
    if dump:
        gm_c.save(dump / "gainmap.png")
        peak = max(2 ** expected_M, 1.01)
        Image.fromarray(tonemap_preview(hdr, peak)).save(dump / "hdr_tonemapped.png")
        bmean8 = np.clip((bmean - 1) / max(bmax - 1, 1e-6) * 255, 0, 255).astype(np.uint8)
        Image.fromarray(bmean8).save(dump / "boost_heatmap.png")
        print(f"\n  dumped gainmap.png / hdr_tonemapped.png / boost_heatmap.png to {dump}")

    print(f"\n=== {'ALL PASS' if ck.failures == 0 else str(ck.failures) + ' FAILURE(S)'} ===")
    return 0 if ck.failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
