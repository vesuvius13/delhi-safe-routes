"""Download the OpenStreetMap extract for Delhi NCT.

Source: openstreetmap.fr's daily state extracts, which are already clipped to
the official Delhi NCT boundary (Narela to Najafgarh to Badarpur), plus the
boundary polygon they were clipped with.

Outputs (data/raw/):
  delhi.osm.pbf   the extract (checksum-verified)
  delhi.poly      boundary polygon (Osmosis .poly format)
  delhi.state     replication state (OSM data timestamp)
"""
import argparse
import hashlib
import sys
import urllib.request
from pathlib import Path

BASE = "http://download.openstreetmap.fr"
NAME = "national_capital_territory_of_delhi"
FILES = {
    "delhi.osm.pbf": f"{BASE}/extracts/asia/india/{NAME}-latest.osm.pbf",
    "delhi.poly": f"{BASE}/polygons/asia/india/{NAME}.poly",
    "delhi.state": f"{BASE}/extracts/asia/india/{NAME}.state.txt",
}
MD5_URL = f"{BASE}/extracts/asia/india/{NAME}.osm.pbf.md5"
USER_AGENT = "delhi-safe-routes/0.1 (open-source pedestrian safety routing)"


def get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=600) as resp:
        return resp.read()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="data/raw", type=Path)
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    for name, url in FILES.items():
        data = get(url)
        if name.endswith(".pbf"):
            expected = get(MD5_URL).decode().split()[0]
            actual = hashlib.md5(data).hexdigest()
            if actual != expected:
                sys.exit(f"Checksum mismatch for {name}: {actual} != {expected}")
        (args.out / name).write_bytes(data)
        print(f"  {name}: {len(data) / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
