# Delhi Safe Routes

Walking directions across all of Delhi NCT that favour well-lit, busy streets over isolated shortcuts, at the time of day you're walking.

Routing runs **entirely in the browser**: the app downloads a 5.6 MB street graph once, and your start point, destination and location never leave your device. It's a static site, so it's free to host on GitHub Pages.

## What it does

- Finds a **safer route** and the **shortest route** between two points and shows both, with the extra distance.
- Scores each street segment separately for **day (6am–6pm), evening (6pm–10pm) and night (10pm–6am)**. A market lane that's fine at 7pm can be empty at 1am.
- Explains the route: share on main roads, share likely to be well lit, open places passed, nearby police, and warnings (parks, industrial land, underpasses, long dark stretches).
- A **Shortest ↔ Safest** slider sets how much of a detour you'll accept.
- Colours the route by exposure (green, amber, red) and shows police stations and hospitals on the map.
- One-tap emergency numbers: 112, 1091 (Delhi Police women helpline), 181.

## How it works

```
openstreetmap.fr daily Delhi extract (.osm.pbf)
        │  pipeline/fetch.py
        ▼
pipeline/build_graph.py ── safety_model.py (features → risk per time band)
        │   walkable ways → junction graph (largest component)
        │   + POIs, street lamps, CCTV, police, stations, land-use polygons
        │   → per-segment risk[day, evening, night] + explanation features
        ▼
web/data/graph.bin.gz  (≈256k junctions, 355k segments, 23,000 km of streets)
        │
        ▼
browser: router.worker.js (A*) + app.js (MapLibre UI)
```

**Edge cost** = `length × (1 + α × 4 × risk[band])`. α = 0 gives the shortest path; α = 1 accepts up to 5× the length to avoid the riskiest segments. The A* heuristic is straight-line distance, which stays admissible because cost ≥ length. A 40 km cross-city route takes about 50 ms.

**Risk features** (see [`pipeline/safety_model.py`](pipeline/safety_model.py) for the weights):

| Raises risk | Lowers risk |
|---|---|
| Road type: paths, tracks, alleys and service roads over main roads | Places likely to be open in that band (shops, eateries, pharmacies, fuel stations, hospitals, hotels), using `opening_hours` when tagged |
| Darkness: `lit=no`, or a low lighting prior for the road type (evening and night only) | `lit=yes` tags and mapped street lamps |
| Share of the segment inside parks, forest, farmland, industrial land, cemeteries, construction sites | Police within 250 m |
| Running alongside large (over 2 ha) isolated areas | Metro/rail stations within 200 m (day and evening) |
| Underpasses and tunnels, foot overbridges at night | Inside residential or commercial areas; CCTV nearby |

This measures the **street environment**, not crime. Delhi Police doesn't publish geocoded incidents. Mapping individual sexual-assault locations would also risk identifying victims (BNS §72).

## Run locally

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python pipeline/fetch.py        # ~27 MB download
.venv/bin/python pipeline/build_graph.py  # ~10 s
python3 -m http.server 8000 --directory web
```

Then open http://localhost:8000.

## Deploy for free (GitHub Pages)

1. Push this folder to a **public** GitHub repo (Actions minutes are free for public repos).
2. Repo **Settings → Pages → Source: GitHub Actions**.
3. The workflow in `.github/workflows/deploy.yml` builds the graph and deploys on every push to `main`, and again every Monday from fresh OSM data.

| Piece | Service | Cost |
|---|---|---|
| App + street graph | GitHub Pages | Free (1 GB site, ~100 GB/month bandwidth) |
| Weekly data rebuild | GitHub Actions | Free for public repos |
| Basemap tiles | [OpenFreeMap](https://openfreemap.org) | Free, no key |
| Place search | [Photon](https://photon.komoot.io) (komoot) | Free, fair use |
| Domain (optional) | any registrar | about ₹800–1,000/year |

## Known limitations

- **OSM coverage is uneven.** Only about 2,100 segments are tagged `lit=yes` and about 1,500 street lamps are mapped, so lighting is mostly inferred from road type. Opening hours are usually defaulted by category. Outer Delhi (Narela, Bawana, Najafgarh) has fewer mapped shops, so scores there lean on road type.
- Walking in both directions is assumed. Gated colonies that close at night aren't known unless tagged `access=private`.
- The weights are priors, not yet calibrated against ground truth.
- Search depends on the public Photon API. If it's down, tapping the map still works.

## Roadmap

- [ ] **Street-imagery lighting and activity** from Mapillary/KartaView with a CV model, to replace road-type priors
- [ ] Night-lights raster (VIIRS) as a coarse lighting layer
- [ ] "Was this route OK?" feedback, and calibrating weights against Safetipin audit data
- [ ] Nearest safe place right now (police, hospital, 24×7 pharmacy, fuel station) and live location sharing
- [ ] Hindi UI

## Data and credits

Street data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL), via [openstreetmap.fr extracts](http://download.openstreetmap.fr/extracts/asia/india/). Map tiles: OpenFreeMap / OpenMapTiles. Map library: MapLibre GL JS. Search: Photon by komoot.
