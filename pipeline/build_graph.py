"""Build the safety-weighted Delhi walking graph for the in-browser router.

Reads data/raw/ (from fetch.py), writes web/data/:
  graph.bin.gz   nodes, edges, per-band risk, explanation features, geometry
  meta.json      section table for graph.bin + model metadata
  names.json     street names for turn-by-turn directions
  places.json    safe places: police, hospitals, metro/rail, fuel, pharmacies with hours
  boundary.json  simplified Delhi NCT outline
"""
import argparse
import gzip
import json
import math
import time
from collections import Counter
from pathlib import Path

import numpy as np
import osmium
import osmium.geom
import shapely
from shapely import STRtree
from shapely.geometry import mapping
from shapely.ops import unary_union

import safety_model as sm

# Local equirectangular projection centred on Delhi: accurate to well under 1%
# across the NCT, and trivially invertible in the browser.
LAT0, LON0 = 28.6139, 77.2090
KX = 111_320.0 * math.cos(math.radians(LAT0))
KY = 110_540.0


def to_xy(lon, lat):
    return (np.asarray(lon) - LON0) * KX, (np.asarray(lat) - LAT0) * KY


def log(msg, t0=[time.time()]):
    print(f"[{time.time() - t0[0]:6.1f}s] {msg}", flush=True)


# --------------------------------------------------------------------------- network

def project_geom(g):
    return shapely.transform(g, lambda c: np.c_[(c[:, 0] - LON0) * KX, (c[:, 1] - LAT0) * KY])


class OsmReader(osmium.SimpleHandler):
    """One pass over the PBF: walkable ways, POIs (nodes and building centroids), land-use areas."""
    KEEP = ("highway", "footway", "service", "lit", "tunnel", "bridge", "layer", "foot",
            "access", "sidewalk", "motorroad", "area", "covered", "name", "name:en", "ref")
    POI_TAGS = ("name", "name:en", "opening_hours", "amenity", "shop", "tourism", "railway",
                "public_transport", "station", "subway", "network", "highway", "man_made",
                "phone", "contact:phone")
    AREA_KEYS = ("leisure", "landuse", "natural", "amenity")

    def __init__(self):
        super().__init__()
        self.ways = []      # (node_ids, tags)
        self.coords = {}    # node id -> (lon, lat)
        self.pois = []      # (kind, lon, lat, tags)
        self.areas = {"green": [], "isolated_land": [], "populated": []}
        self._wkb = osmium.geom.WKBFactory()

    def _poi_tags(self, obj):
        return {k: obj.tags[k] for k in self.POI_TAGS if k in obj.tags}

    def node(self, n):
        if not n.tags:
            return
        t = self._poi_tags(n)
        kind = sm.classify_poi(t)
        if kind is not None and n.location.valid():
            self.pois.append((kind, n.location.lon, n.location.lat, t))

    def area(self, a):
        keys = {(k, a.tags.get(k)) for k in self.AREA_KEYS}
        cls = ("green" if keys & sm.GREEN else
               "isolated_land" if keys & sm.ISOLATED_LAND else
               "populated" if keys & sm.POPULATED else None)
        t = self._poi_tags(a) if ("shop" in a.tags or "amenity" in a.tags or "tourism" in a.tags
                                  or "railway" in a.tags or "public_transport" in a.tags) else None
        kind = sm.classify_poi(t) if t else None
        if cls is None and kind is None:
            return
        try:
            geom = shapely.from_wkb(bytes.fromhex(self._wkb.create_multipolygon(a)))
        except RuntimeError:  # broken multipolygon in OSM
            return
        if kind is not None:
            c = geom.representative_point()
            self.pois.append((kind, c.x, c.y, t))
        if cls is not None:
            self.areas[cls].append(shapely.make_valid(project_geom(geom)))

    def way(self, w):
        t = {k: w.tags[k] for k in self.KEEP if k in w.tags}
        hw = t.get("highway")
        if hw not in sm.ROAD_CLASS or t.get("area") == "yes" or t.get("motorroad") == "yes":
            return
        foot, access = t.get("foot"), t.get("access")
        if foot in ("no", "private", "use_sidepath"):
            return
        if access in ("no", "private") and foot not in ("yes", "designated", "permissive"):
            return
        ids = []
        for n in w.nodes:
            if not n.location.valid():
                continue
            if ids and ids[-1] == n.ref:
                continue
            ids.append(n.ref)
            self.coords[n.ref] = (n.lon, n.lat)
        if len(ids) >= 2:
            self.ways.append((ids, t))


def split_ways(ways):
    """Split ways at junctions -> edges (u_osm, v_osm, node id list, way index)."""
    uses = Counter()
    for ids, _ in ways:
        uses.update(ids)
        uses[ids[0]] += 1
        uses[ids[-1]] += 1
    edges = []
    for wi, (ids, _) in enumerate(ways):
        seg = [ids[0]]
        for nid in ids[1:]:
            seg.append(nid)
            if uses[nid] >= 2:
                if seg[0] != seg[-1]:
                    edges.append((seg, wi))
                seg = [nid]
    return edges


def largest_component(n_nodes, u, v):
    parent = np.arange(n_nodes)

    def find(a):
        root = a
        while parent[root] != root:
            root = parent[root]
        while parent[a] != root:
            parent[a], a = root, parent[a]
        return root

    for a, b in zip(u.tolist(), v.tolist()):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb
    roots = np.array([find(i) for i in range(n_nodes)])
    counts = np.bincount(roots, minlength=n_nodes)
    return roots == counts.argmax(), counts.max(), (counts > 0).sum()


# --------------------------------------------------------------------------- boundary

def load_poly(path):
    """Parse an Osmosis .poly file into a (Multi)Polygon in lon/lat."""
    lines = [ln.strip() for ln in Path(path).read_text().splitlines() if ln.strip()]
    shells, holes, ring, hole = [], [], None, False
    for ln in lines[1:]:
        if ring is None:
            if ln == "END":
                break
            ring, hole = [], ln.startswith("!")
        elif ln == "END":
            (holes if hole else shells).append(shapely.Polygon(ring))
            ring = None
        else:
            lon, lat = map(float, ln.split()[:2])
            ring.append((lon, lat))
    geom = unary_union(shells)
    return geom.difference(unary_union(holes)) if holes else geom


# --------------------------------------------------------------------------- features

def edge_features(lines, lengths, way_tags, edge_way, pois, areas):
    E = len(lines)
    tree = STRtree(lines)
    f = {}

    # Road class, lighting prior, structures
    base = np.empty(E, np.float32)
    light = np.empty(E, np.float32)
    flags = np.zeros(E, np.uint16)
    underpass = np.zeros(E, np.float32)
    footbridge = np.zeros(E, np.float32)
    bit = lambda name: np.uint16(1 << sm.FLAGS[name])  # noqa: E731
    for i, wi in enumerate(edge_way):
        t = way_tags[wi]
        hw = t["highway"]
        b, l0 = sm.road_class(t)
        base[i] = b
        lit = sm.LIT_TAG.get(t.get("lit", ""))
        light[i] = l0 if lit is None else lit
        if lit is not None and lit >= 0.6:
            flags[i] |= bit("lit_tag_yes")
        elif lit == 0.0:
            flags[i] |= bit("lit_tag_no")
        if hw in sm.MAIN_ROADS or t.get("footway") == "sidewalk":
            flags[i] |= bit("main_road")
        if hw.startswith("trunk"):
            flags[i] |= bit("trunk")
        if hw in sm.PATHLIKE:
            flags[i] |= bit("pathlike")
        if hw == "service" or t.get("service") == "alley":
            flags[i] |= bit("alley_service")
        try:
            layer = int(t.get("layer", "0"))
        except ValueError:
            layer = 0
        if t.get("tunnel") in ("yes", "culvert") or (layer < 0 and hw in ("footway", "path", "steps", "pedestrian")):
            underpass[i] = 1
            flags[i] |= bit("underpass")
        elif t.get("bridge") and t.get("bridge") != "no" and hw in ("footway", "steps", "path", "pedestrian"):
            footbridge[i] = 1
            flags[i] |= bit("footbridge")
    log(f"  road classes done ({(flags & bit('lit_tag_yes') > 0).sum()} edges tagged lit=yes)")

    # POIs
    kinds = np.array([p[0] for p in pois])
    px, py = to_xy([p[1] for p in pois], [p[2] for p in pois])
    pts = shapely.points(np.c_[px, py])

    def near(mask, radius):
        pi, ei = tree.query(pts[mask], predicate="dwithin", distance=radius)
        return np.flatnonzero(mask)[pi], ei

    # Open places ("eyes on the street") weighted by how likely they're open in each band
    active_mask = ~np.isin(kinds, ["lamp", "cctv"])
    profile = np.array([sm.open_profile(k, p[3]) if m else (0,) * sm.N_BANDS
                        for k, p, m in zip(kinds, pois, active_mask)], np.float32)
    pi, ei = near(active_mask, sm.POI_RADIUS)
    open_sum = np.zeros((E, sm.N_BANDS), np.float32)
    np.add.at(open_sum, ei, profile[pi])
    density = open_sum / np.maximum(lengths, 50.0)[:, None] * 100.0     # open places per 100 m
    f["activity"] = 1.0 - np.exp(-density / 1.5)
    f["open_count"] = open_sum
    log(f"  {active_mask.sum()} active places -> {len(pi)} place-segment links")

    pi, ei = near(kinds == "lamp", sm.LAMP_RADIUS)
    lamps = np.bincount(ei, minlength=E)
    light = np.maximum(light, np.where(lamps > 0, np.minimum(1.0, 0.5 + 0.25 * lamps), 0))
    flags[lamps > 0] |= bit("lit_tag_yes")
    log(f"  {(kinds == 'lamp').sum()} street lamps -> {(lamps > 0).sum()} lit segments")

    pi, ei = near(kinds == "cctv", sm.CCTV_RADIUS)
    cctv = np.zeros(E, np.float32)
    cctv[ei] = 1
    flags[ei] |= bit("cctv")

    pi, ei = near(kinds == "police", sm.POLICE_RADIUS)
    police = np.zeros(E, np.float32)
    police[ei] = 1
    flags[ei] |= bit("near_police")

    pi, ei = near(kinds == "station", sm.STATION_RADIUS)
    station = np.zeros(E, np.float32)
    station[ei] = 1
    flags[ei] |= bit("near_station")
    log(f"  police {(kinds == 'police').sum()}, stations {(kinds == 'station').sum()}, cctv {(kinds == 'cctv').sum()}")

    # Areas: share of the segment inside isolated land; running alongside big isolated areas
    def inside_fraction(polys):
        if not polys:
            return np.zeros(E, np.float32)
        polys = np.array(polys)
        ptree = STRtree(polys)
        ei, ai = ptree.query(lines, predicate="intersects")
        frac = np.zeros(E, np.float32)
        inter = shapely.length(shapely.intersection(lines[ei], polys[ai])) / np.maximum(lengths[ei], 1e-6)
        np.maximum.at(frac, ei, np.minimum(inter, 1.0).astype(np.float32))
        return frac

    green = inside_fraction(areas["green"])
    iso_land = inside_fraction(areas["isolated_land"])
    f["inside_isolated"] = np.maximum(green, iso_land)
    flags[green >= 0.5] |= bit("inside_green")
    flags[iso_land >= 0.5] |= bit("inside_isolated_land")

    big = [p for p in areas["green"] + areas["isolated_land"] if p.area >= sm.BIG_ISOLATED_AREA_M2]
    along = np.zeros(E, np.float32)
    if big:
        ei, _ = STRtree(np.array(big)).query(lines, predicate="dwithin", distance=sm.ALONG_ISOLATED_RADIUS)
        along[ei] = 1
    along[f["inside_isolated"] >= 0.5] = 0
    flags[along > 0] |= bit("along_isolated")

    populated = np.zeros(E, np.float32)
    if areas["populated"]:
        mids = shapely.line_interpolate_point(lines, 0.5, normalized=True)
        ei, _ = STRtree(np.array(areas["populated"])).query(mids, predicate="within")
        populated[ei] = 1
    log(f"  inside green {(green >= 0.5).sum()}, inside isolated land {(iso_land >= 0.5).sum()}, "
        f"along isolated {int(along.sum())}, in populated areas {int(populated.sum())}")

    f.update(base_risk=base, light=light, underpass=underpass, footbridge=footbridge, along_isolated=along,
             near_police=police, near_station=station, populated=populated, cctv=cctv)
    return f, flags


# --------------------------------------------------------------------------- turn-by-turn labels

# How an unnamed segment is described in directions ("Turn left onto the footpath").
KIND_LABELS = {
    "road": "the road", "street": "the street", "service": "the service road", "lane": "the lane",
    "pedestrian": "the pedestrian street", "footpath": "the footpath", "crossing": "the crossing",
    "path": "the path", "track": "the track", "steps": "the steps", "corridor": "the corridor",
    "cycleway": "the cycle path",
}


def street_kind(tags: dict) -> str:
    hw = tags["highway"]
    if hw == "footway":
        return "crossing" if tags.get("footway") == "crossing" else "footpath"
    if hw == "service":
        return "lane" if tags.get("service") == "alley" else "service"
    if hw in ("residential", "living_street"):
        return "street"
    if hw in ("path", "bridleway"):
        return "path"
    return hw if hw in KIND_LABELS else "road"


def street_labels(way_tags, edge_way):
    """Per-edge name index and kind index, plus the lookup tables."""
    kinds = list(KIND_LABELS)
    kind_idx = {k: i for i, k in enumerate(kinds)}
    names, name_idx = [""], {"": 0}
    edge_name = np.zeros(len(edge_way), np.uint32)
    edge_kind = np.zeros(len(edge_way), np.uint8)
    for i, wi in enumerate(edge_way):
        t = way_tags[wi]
        nm = (t.get("name:en") or t.get("name") or t.get("ref") or "").strip()
        if nm not in name_idx:
            name_idx[nm] = len(names)
            names.append(nm)
        edge_name[i] = name_idx[nm]
        edge_kind[i] = kind_idx[street_kind(t)]
    if len(names) < 65536:
        edge_name = edge_name.astype(np.uint16)
    return edge_name, edge_kind, names, [KIND_LABELS[k] for k in kinds], kind_idx


# --------------------------------------------------------------------------- safe places

def safe_place_kind(kind, tags):
    """Places to head for if you feel unsafe: staffed, lit, usually open. None = not one."""
    if kind in ("police", "hospital", "fuel"):
        return kind
    if kind == "pharmacy":
        return "pharmacy" if tags.get("opening_hours") else None  # without hours we can't say it's open
    if kind == "station":
        metro = (tags.get("station") == "subway" or tags.get("subway") == "yes"
                 or tags.get("railway") == "subway_entrance"
                 or "metro" in (tags.get("network", "") + tags.get("name", "")).lower())
        return "metro" if metro else "rail"
    return None


# --------------------------------------------------------------------------- export

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", default="data/raw", type=Path)
    ap.add_argument("--out", default="web/data", type=Path)
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    log("reading OSM extract")
    rd = OsmReader()
    rd.apply_file(str(args.raw / "delhi.osm.pbf"), locations=True)
    pois, areas = rd.pois, rd.areas
    log(f"  {len(rd.ways)} walkable ways, {len(rd.coords)} nodes, {len(pois)} POIs; areas: "
        + ", ".join(f"{k} {len(p)}" for k, p in areas.items()))

    raw_edges = split_ways(rd.ways)
    ends = sorted({s[0] for s, _ in raw_edges} | {s[-1] for s, _ in raw_edges})
    idx = {nid: i for i, nid in enumerate(ends)}
    u = np.array([idx[s[0]] for s, _ in raw_edges])
    v = np.array([idx[s[-1]] for s, _ in raw_edges])
    keep_node, n_big, n_comp = largest_component(len(ends), u, v)
    keep_edge = keep_node[u]
    log(f"  {len(raw_edges)} edges, {len(ends)} junctions, {n_comp} components; "
        f"keeping largest ({n_big} nodes, {keep_edge.sum()} edges)")

    raw_edges = [e for e, k in zip(raw_edges, keep_edge) if k]
    new_id = np.cumsum(keep_node) - 1
    u, v = new_id[u[keep_edge]], new_id[v[keep_edge]]
    node_osm = np.array(ends)[keep_node]
    node_lon = np.array([rd.coords[n][0] for n in node_osm])
    node_lat = np.array([rd.coords[n][1] for n in node_osm])

    # Edge geometries in metres
    counts = np.array([len(s) for s, _ in raw_edges])
    flat = [rd.coords[n] for s, _ in raw_edges for n in s]
    gx, gy = to_xy([c[0] for c in flat], [c[1] for c in flat])
    lines = shapely.linestrings(np.c_[gx, gy], indices=np.repeat(np.arange(len(raw_edges)), counts))
    lengths = shapely.length(lines)
    edge_way = [wi for _, wi in raw_edges]
    log(f"  total walkable length {lengths.sum() / 1000:.0f} km")

    log("computing features")
    feats, flags = edge_features(lines, lengths, [t for _, t in rd.ways], edge_way, pois, areas)
    risk = sm.risk_scores(feats)
    for b, (name, *_rest) in enumerate(sm.BANDS):
        r = risk[:, b]
        log(f"  {name:8s} risk: mean {np.average(r, weights=lengths):.2f}, "
            f"p90 {np.percentile(r, 90):.2f}, >0.5 {(r > 0.5).mean() * 100:.0f}% of segments")

    log("simplifying geometry and writing output")
    simple = shapely.simplify(lines, 1.0)
    coords, gi = shapely.get_coordinates(simple, return_index=True)
    per = np.bincount(gi, minlength=len(lines))
    starts = np.r_[0, np.cumsum(per)[:-1]]
    interior = np.ones(len(coords), bool)
    interior[starts] = False
    interior[starts + per - 1] = False
    geom = coords[interior]
    geom_off = np.r_[0, np.cumsum(per - 2)].astype(np.uint32)
    geom_lon = geom[:, 0] / KX + LON0
    geom_lat = geom[:, 1] / KY + LAT0

    edge_name, edge_kind, names, kind_labels, kind_idx = street_labels([t for _, t in rd.ways], edge_way)
    log(f"  {len(names) - 1} street names; {(edge_name > 0).mean() * 100:.0f}% of segments named")

    micro = lambda a: np.round(np.asarray(a) * 1e6).astype(np.int32)  # noqa: E731
    sections = {
        "nodes": np.c_[micro(node_lon), micro(node_lat)].ravel(),
        "edge_u": u.astype(np.uint32),
        "edge_v": v.astype(np.uint32),
        "edge_len": lengths.astype(np.float32),
        "edge_flags": flags,
        "edge_risk": np.round(risk * 255).astype(np.uint8).ravel(),
        "edge_light": np.round(feats["light"] * 255).astype(np.uint8),
        "edge_open": np.minimum(np.round(feats["open_count"] * 10), 255).astype(np.uint8).ravel(),
        "edge_name": edge_name,
        "edge_kind": edge_kind,
        "geom_off": geom_off,
        "geom": np.c_[micro(geom_lon), micro(geom_lat)].ravel(),
    }
    blob, table, off = bytearray(), {}, 0
    for name, arr in sections.items():
        b = arr.tobytes()
        table[name] = {"offset": off, "length": int(arr.size), "dtype": arr.dtype.name}
        blob += b + b"\0" * (-len(b) % 8)
        off = len(blob)
    with gzip.open(args.out / "graph.bin.gz", "wb", compresslevel=9) as fz:
        fz.write(bytes(blob))

    state = dict(ln.split("=", 1) for ln in (args.raw / "delhi.state").read_text().splitlines() if "=" in ln)
    osm_ts = state.get("timestamp", "").replace("\\:", ":") or None
    meta = {
        "version": 1,
        "built": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "osm_timestamp": osm_ts,
        "nodes": int(len(node_osm)), "edges": int(len(u)),
        "projection": {"lat0": LAT0, "lon0": LON0, "kx": KX, "ky": KY},
        "bands": [{"id": n, "label": lab, "start": s, "end": e} for n, lab, s, e in sm.BANDS],
        "risk_multiplier": sm.RISK_MULTIPLIER,
        "flags": sm.FLAGS,
        "open_count_scale": 10,
        "kind_labels": kind_labels,
        "crossing_kind": kind_idx["crossing"],
        "sections": table,
        "bytes": len(blob),
    }
    (args.out / "meta.json").write_text(json.dumps(meta, indent=1))
    (args.out / "names.json").write_text(json.dumps(names, ensure_ascii=False, separators=(",", ":")))

    places = []
    for k, lon, lat, t in pois:
        kind = safe_place_kind(k, t)
        if kind is None:
            continue
        pl = {"k": kind, "n": t.get("name:en") or t.get("name") or "", "lon": round(lon, 6), "lat": round(lat, 6)}
        if t.get("phone") or t.get("contact:phone"):
            pl["p"] = (t.get("phone") or t.get("contact:phone")).split(";")[0].strip()
        if t.get("opening_hours"):
            pl["h"] = t["opening_hours"]
        places.append(pl)
    (args.out / "places.json").write_text(json.dumps(places, ensure_ascii=False, separators=(",", ":")))

    boundary = load_poly(args.raw / "delhi.poly").simplify(0.0005)
    (args.out / "boundary.json").write_text(json.dumps(mapping(boundary)))

    gz = (args.out / "graph.bin.gz").stat().st_size
    log(f"done: graph {len(blob) / 1e6:.1f} MB raw, {gz / 1e6:.1f} MB gzipped; {len(places)} places")


if __name__ == "__main__":
    main()
