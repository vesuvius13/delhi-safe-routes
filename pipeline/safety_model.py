"""The safety model: how street features turn into a per-segment risk score.

Every walkable street segment gets a risk in [0, 1] for each time band. The
browser router then uses   cost = length * (1 + alpha * RISK_MULTIPLIER * risk)
so alpha = 0 is the plain shortest path and alpha = 1 lets the router walk up
to (1 + RISK_MULTIPLIER)x further to avoid the riskiest segments.

The features come from what the literature on street safety (and Safetipin's
audit parameters) treats as protective or risky: lighting, "eyes on the
street" (open shops and eateries), road type, isolated land (parks, forests,
industrial estates at night), underpasses, and nearby police / transit.

It measures the *environment*, not crime. All numbers here are priors meant
to be tuned against ground truth (audits, user feedback).
"""
import re

import numpy as np

BANDS = [
    # name, label, start hour, end hour (end < start wraps past midnight)
    ("day", "Day (6am-6pm)", 6, 18),
    ("evening", "Evening (6pm-10pm)", 18, 22),
    ("night", "Night (10pm-6am)", 22, 6),
]
N_BANDS = len(BANDS)
RISK_MULTIPLIER = 4.0

# highway class -> (base risk, prior probability the segment is well lit)
ROAD_CLASS = {
    "trunk": (0.20, 0.85), "trunk_link": (0.30, 0.75),
    "primary": (0.10, 0.85), "primary_link": (0.25, 0.75),
    "secondary": (0.10, 0.80), "secondary_link": (0.25, 0.70),
    "tertiary": (0.15, 0.75), "tertiary_link": (0.25, 0.65),
    "unclassified": (0.35, 0.50), "road": (0.35, 0.50),
    "residential": (0.30, 0.60), "living_street": (0.25, 0.60),
    "pedestrian": (0.15, 0.70), "corridor": (0.25, 0.70),
    "service": (0.45, 0.40), "cycleway": (0.45, 0.40),
    "footway": (0.45, 0.35), "steps": (0.50, 0.35),
    "path": (0.70, 0.10), "track": (0.80, 0.05), "bridleway": (0.80, 0.05),
}
SIDEWALK = (0.15, 0.80)   # footway=sidewalk: behaves like the road beside it
CROSSING = (0.20, 0.70)   # footway=crossing
ALLEY = (0.60, 0.30)      # service=alley
MAIN_ROADS = {k for k in ROAD_CLASS if k.split("_")[0] in ("trunk", "primary", "secondary", "tertiary")}
PATHLIKE = {"path", "track", "bridleway"}

LIT_TAG = {"yes": 1.0, "24/7": 1.0, "automatic": 0.9, "sunset-sunrise": 1.0, "limited": 0.6,
           "interval": 0.6, "disused": 0.0, "no": 0.0}

# How likely a place is open (and so adds people and light to the street) per band.
# Used when the POI has no usable opening_hours tag.
OPEN_PROFILE = {
    "shop": (1.0, 0.8, 0.05),
    "shop:convenience": (1.0, 0.9, 0.10), "shop:supermarket": (1.0, 0.9, 0.05),
    "shop:kiosk": (1.0, 0.7, 0.10), "shop:bakery": (1.0, 0.8, 0.05),
    "restaurant": (0.9, 1.0, 0.25), "fast_food": (0.9, 1.0, 0.30), "cafe": (0.9, 0.9, 0.15),
    "food_court": (0.9, 1.0, 0.20), "ice_cream": (0.8, 1.0, 0.10),
    "bar": (0.3, 1.0, 0.50), "pub": (0.3, 1.0, 0.50),
    "pharmacy": (1.0, 0.9, 0.15), "hospital": (1.0, 1.0, 1.0),
    "clinic": (1.0, 0.6, 0.05), "doctors": (1.0, 0.6, 0.05),
    "fuel": (1.0, 1.0, 0.70), "atm": (1.0, 1.0, 0.50), "bank": (1.0, 0.1, 0.0),
    "cinema": (1.0, 1.0, 0.40), "marketplace": (1.0, 0.8, 0.0),
    "bus_station": (1.0, 1.0, 0.60), "place_of_worship": (1.0, 0.7, 0.10),
    "hotel": (1.0, 1.0, 1.0), "guest_house": (1.0, 1.0, 0.8),
    "police": (1.0, 1.0, 1.0),
    "station": (1.0, 1.0, 0.20),     # rail/metro stations; Delhi Metro closes ~23:00
    "bus_stop": (0.4, 0.3, 0.02),
}

# Distances (metres) used for feature extraction.
POI_RADIUS = 40        # an open place within this distance puts eyes on the segment
LAMP_RADIUS = 20

# Mapillary: street lights detected in street-level photos, and where photos exist at all.
MLY_LIGHT_RADIUS = 25        # detections are placed approximately; a bit more slack than OSM lamps
MLY_DETECTED_LIGHT = 0.85    # a detected light pole: likely lit, though not proof it works
MLY_SURVEY_RADIUS = 15       # photos this close to a segment count as coverage of it
MLY_SURVEY_PER_100M = 5      # ...and it needs this many photos per 100 m to count as surveyed
MLY_MIN_SURVEY_LEN = 40      # shorter segments are too short to judge "no light seen"
MLY_SURVEYED_DARK = 0.75     # surveyed, yet no light seen anywhere near: scale the lighting prior down
MLY_MAX_AGE_YEARS = 6        # ignore photos and detections older than this
CCTV_RADIUS = 30
POLICE_RADIUS = 250
STATION_RADIUS = 200
ALONG_ISOLATED_RADIUS = 25
BIG_ISOLATED_AREA_M2 = 20_000   # parks smaller than 2 ha don't make the street beside them lonely

GREEN = {("leisure", "park"), ("leisure", "nature_reserve"), ("leisure", "golf_course"),
         ("landuse", "forest"), ("landuse", "meadow"), ("natural", "wood"), ("natural", "scrub"),
         ("natural", "heath"), ("natural", "grassland"), ("natural", "wetland")}
ISOLATED_LAND = {("landuse", "industrial"), ("landuse", "cemetery"), ("amenity", "grave_yard"),
                 ("landuse", "military"), ("landuse", "brownfield"), ("landuse", "construction"),
                 ("landuse", "landfill"), ("landuse", "quarry"), ("landuse", "farmland")}
POPULATED = {("landuse", "residential"), ("landuse", "commercial"), ("landuse", "retail")}

# Per-band weights. Darkness doesn't matter by day; isolation matters much more at night.
W = {
    "base_scale": np.array([0.5, 1.0, 1.0]),
    "dark": np.array([0.0, 0.28, 0.35]),
    "inside_isolated": np.array([0.15, 0.40, 0.50]),
    "along_isolated": np.array([0.05, 0.12, 0.15]),
    "underpass": np.array([0.15, 0.35, 0.40]),
    "footbridge": np.array([0.0, 0.10, 0.15]),
    "activity": np.array([0.25, 0.40, 0.45]),
    "police": np.array([0.05, 0.10, 0.12]),
    "station": np.array([0.05, 0.08, 0.0]),
    "populated": np.array([0.05, 0.05, 0.05]),
    "cctv": np.array([0.02, 0.05, 0.05]),
}

# Flag bits stored per edge and used by the browser to explain a route.
FLAGS = {
    "main_road": 0, "lit_tag_yes": 1, "lit_tag_no": 2, "inside_green": 3,
    "inside_isolated_land": 4, "along_isolated": 5, "underpass": 6, "footbridge": 7,
    "near_police": 8, "near_station": 9, "pathlike": 10, "cctv": 11, "alley_service": 12,
    "trunk": 13, "lit_detected": 14, "surveyed": 15,
}


def road_class(tags: dict) -> tuple[float, float]:
    hw = tags.get("highway")
    if hw == "footway" and tags.get("footway") == "sidewalk":
        return SIDEWALK
    if hw == "footway" and tags.get("footway") == "crossing":
        return CROSSING
    if hw == "service" and tags.get("service") == "alley":
        return ALLEY
    return ROAD_CLASS.get(hw, (0.5, 0.3))


_RANGE = re.compile(r"(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})")


def band_open_fraction(opening_hours: str | None) -> tuple[float, ...] | None:
    """Rough parse of an OSM opening_hours string into fraction-open per band.

    Ignores weekdays and exceptions: good enough to separate "closes at 7pm"
    from "open till 2am". Returns None if unparseable.
    """
    if not opening_hours:
        return None
    s = opening_hours.strip()
    if "24/7" in s or re.fullmatch(r"(Mo-Su\s+)?00:00\s*-\s*(24|00):00", s):
        return (1.0,) * N_BANDS
    ranges = _RANGE.findall(s)
    if not ranges:
        return None
    open_min = np.zeros(24 * 60, dtype=bool)
    for h1, m1, h2, m2 in ranges:
        a = (int(h1) * 60 + int(m1)) % 1440
        b = int(h2) * 60 + int(m2)
        b = 1440 if b >= 1440 else b
        if b > a:
            open_min[a:b] = True
        else:  # past midnight
            open_min[a:] = True
            open_min[:b] = True
    out = []
    for _, _, start, end in BANDS:
        mask = np.zeros(24 * 60, dtype=bool)
        if end > start:
            mask[start * 60:end * 60] = True
        else:
            mask[start * 60:] = True
            mask[:end * 60] = True
        out.append(float(open_min[mask].mean()))
    return tuple(out)


def classify_poi(tags: dict) -> str | None:
    """Map OSM tags to a POI kind used by the model (None = ignore)."""
    hw = tags.get("highway")
    if hw == "street_lamp":
        return "lamp"
    if hw == "bus_stop":
        return "bus_stop"
    if tags.get("man_made") == "surveillance":
        return "cctv"
    if tags.get("amenity") == "police":
        return "police"
    if tags.get("railway") in ("station", "subway_entrance") or tags.get("public_transport") == "station":
        return "station"
    am = tags.get("amenity")
    if am in OPEN_PROFILE:
        return am
    tour = tags.get("tourism")
    if tour in OPEN_PROFILE:
        return tour
    shop = tags.get("shop")
    if shop and shop not in ("vacant", "no"):
        return f"shop:{shop}" if f"shop:{shop}" in OPEN_PROFILE else "shop"
    return None


def open_profile(kind: str, tags: dict) -> tuple[float, ...]:
    parsed = band_open_fraction(tags.get("opening_hours"))
    return parsed if parsed is not None else OPEN_PROFILE.get(kind, (0.0,) * N_BANDS)


def risk_scores(f: dict) -> np.ndarray:
    """Combine per-edge features (arrays of length E) into risk (E, N_BANDS) in [0, 1]."""
    col = lambda a: np.asarray(a, dtype=np.float32)[:, None]  # noqa: E731
    r = (
        col(f["base_risk"]) * W["base_scale"]
        + col(1.0 - f["light"]) * W["dark"]
        + col(f["inside_isolated"]) * W["inside_isolated"]
        + col(f["along_isolated"]) * W["along_isolated"]
        + col(f["underpass"]) * W["underpass"]
        + col(f["footbridge"]) * W["footbridge"]
        - f["activity"] * W["activity"]
        - col(f["near_police"]) * W["police"]
        - col(f["near_station"]) * W["station"]
        - col(f["populated"]) * W["populated"]
        - col(f["cctv"]) * W["cctv"]
    )
    return np.clip(r, 0.0, 1.0)
