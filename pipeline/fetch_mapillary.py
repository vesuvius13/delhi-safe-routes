"""Download Mapillary street-light detections and photo coverage for Delhi NCT.

Mapillary runs object detection on its street-level photos and publishes the
results as map features. We take the `object--street-light` points, plus the
positions of the photos themselves, so the graph builder can tell "no lights
seen" (street photographed, nothing detected) from "no data" (never photographed).

Needs a Mapillary client token (free): env MAPILLARY_TOKEN, or a file named
`.mapillary_token` in the project root. Without one, this exits cleanly and the
graph is built from OpenStreetMap alone.

Outputs (data/raw/):
  mapillary_lights.json   [[lon, lat, first_seen_ms, last_seen_ms], ...]
  mapillary_images.npz    lon, lat, captured_at_ms of photos
"""
import argparse
import json
import math
import os
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import mapbox_vector_tile
import numpy as np
import shapely

ZOOM = 14  # the zoom at which Mapillary serves individual points
FEATURES_URL = "https://tiles.mapillary.com/maps/vtp/mly_map_feature_point/2/{z}/{x}/{y}?access_token={token}"
COVERAGE_URL = "https://tiles.mapillary.com/maps/vtp/mly1_public/2/{z}/{x}/{y}?access_token={token}"
LIGHT = "object--street-light"
ROOT = Path(__file__).resolve().parent.parent


def token() -> str | None:
    t = os.environ.get("MAPILLARY_TOKEN", "").strip()
    f = ROOT / ".mapillary_token"
    if not t and f.exists():
        t = f.read_text().strip()
    return t or None


def load_poly(path: Path):
    lines = [ln.strip() for ln in path.read_text().splitlines() if ln.strip()]
    rings, ring = [], None
    for ln in lines[1:]:
        if ring is None:
            if ln == "END":
                break
            ring = []
        elif ln == "END":
            rings.append(shapely.Polygon(ring))
            ring = None
        else:
            ring.append(tuple(map(float, ln.split()[:2])))
    return shapely.union_all(rings)


def tile_xy(lon, lat, z):
    n = 2 ** z
    x = int((lon + 180) / 360 * n)
    y = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
    return x, y


def tile_lonlat(x, y, z):
    """Top-left corner of a tile (fractional x, y allowed)."""
    n = 2 ** z
    lon = x / n * 360 - 180
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    return lon, lat


def tiles_for(area, z):
    minx, miny, maxx, maxy = area.bounds
    x0, y0 = tile_xy(minx, maxy, z)
    x1, y1 = tile_xy(maxx, miny, z)
    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            (w, n), (e, s) = tile_lonlat(x, y, z), tile_lonlat(x + 1, y + 1, z)
            if area.intersects(shapely.box(w, s, e, n)):
                yield x, y


def fetch_tile(url: str, retries: int = 4) -> bytes | None:
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "delhi-safe-routes/0.1"})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                raise SystemExit(f"Mapillary refused the token (HTTP {e.code}). Check it's a valid client token.")
            if e.code == 404:
                return None  # no data in this tile
            time.sleep(2 ** attempt)
        except (urllib.error.URLError, TimeoutError):
            time.sleep(2 ** attempt)
    print(f"  giving up on {url.split('?')[0]}", file=sys.stderr)
    return None


def decode_points(data: bytes, layer: str, x: int, y: int, z: int):
    """Yield (lon, lat, properties) for point features in one vector tile layer."""
    tile = mapbox_vector_tile.decode(data, default_options={"y_coord_down": True})
    lyr = tile.get(layer)
    if not lyr:
        return
    ext = lyr.get("extent", 4096)
    for f in lyr["features"]:
        g = f["geometry"]
        pts = [g["coordinates"]] if g["type"] == "Point" else g["coordinates"] if g["type"] == "MultiPoint" else []
        for px, py in pts:
            lon, lat = tile_lonlat(x + px / ext, y + py / ext, z)
            yield lon, lat, f.get("properties", {})


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--raw", default="data/raw", type=Path)
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args()

    tok = token()
    if not tok:
        print("  No Mapillary token (MAPILLARY_TOKEN or .mapillary_token): skipping; lighting uses OSM only.")
        return

    area = load_poly(args.raw / "delhi.poly")
    tiles = list(tiles_for(area, ZOOM))
    print(f"  {len(tiles)} tiles at z{ZOOM} cover Delhi")
    t0 = time.time()

    def one(xy):
        x, y = xy
        lights, images = [], []
        data = fetch_tile(FEATURES_URL.format(z=ZOOM, x=x, y=y, token=tok))
        if data:
            for lon, lat, p in decode_points(data, "point", x, y, ZOOM):
                if p.get("value") == LIGHT:
                    lights.append([round(lon, 6), round(lat, 6), p.get("first_seen_at"), p.get("last_seen_at")])
        data = fetch_tile(COVERAGE_URL.format(z=ZOOM, x=x, y=y, token=tok))
        if data:
            for lon, lat, p in decode_points(data, "image", x, y, ZOOM):
                images.append((lon, lat, p.get("captured_at") or 0))
        return lights, images

    lights, images = [], []
    with ThreadPoolExecutor(args.workers) as pool:
        for i, (lt, im) in enumerate(pool.map(one, tiles), 1):
            lights += lt
            images += im
            if i % 100 == 0:
                print(f"  {i}/{len(tiles)} tiles, {len(lights)} lights, {len(images)} photos ({time.time() - t0:.0f}s)")

    # Keep only what falls inside Delhi
    if lights:
        inside = shapely.contains_xy(area, [l[0] for l in lights], [l[1] for l in lights])
        lights = [l for l, k in zip(lights, inside) if k]
    im = np.array(images, dtype=np.float64).reshape(-1, 3)
    if len(im):
        im = im[shapely.contains_xy(area, im[:, 0], im[:, 1])]

    (args.raw / "mapillary_lights.json").write_text(json.dumps(lights))
    np.savez_compressed(args.raw / "mapillary_images.npz", lon=im[:, 0].astype(np.float32),
                        lat=im[:, 1].astype(np.float32), captured_at=im[:, 2].astype(np.int64))
    print(f"  done: {len(lights)} street lights, {len(im)} photos in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
