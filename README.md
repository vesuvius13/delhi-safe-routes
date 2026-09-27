# Delhi Safe Routes

Walking directions across all of Delhi NCT that favour well-lit, busy streets over isolated shortcuts, at the time of day you're walking.

**Try it: https://vesuvius13.github.io/delhi-safe-routes/** (works on any phone browser; add it to your home screen to install it)

Routing runs **entirely in the browser**: the app downloads a 5.7 MB street graph once, and your start point, destination and location never leave your device. It's a static site, so it's free to host on GitHub Pages.

## What it does

- Finds a **safer route** and the **shortest route** between two points and shows both, with the extra distance.
- Scores each street segment separately for **day (6am–6pm), evening (6pm–10pm) and night (10pm–6am)**. A market lane that's fine at 7pm can be empty at 1am.
- Explains the route: share on main roads, share likely to be well lit, open places passed, nearby police, and warnings (parks, industrial land, underpasses, long dark stretches).
- A **Shortest ↔ Safest** slider sets how much of a detour you'll accept.
- Colours the route by exposure (green, amber, red) and shows police stations (blue dots) and hospitals (+ markers) on the map.
- **Turn-by-turn navigation**: tap **Start** to follow the route by GPS. It shows the next turn with distance and a "then" preview, gives voice prompts (can be muted), keeps the screen on, and reroutes from where you are if you leave the route. A step-by-step directions list is also available before you start.
- **Safe places near me**: the nearest police, hospitals and places open right now (metro stations while running, rail stations, fuel stations, pharmacies with listed hours), ranked by walking distance, with **Go** (starts navigation) and **Call**.
- **Share my location**: sends a Google Maps link with your position to a contact via WhatsApp, SMS or the share menu. During navigation it adds your destination and ETA.
- One-tap emergency numbers: 112, 1091 (Delhi Police women helpline), 181.

## How it works

```
openstreetmap.fr daily Delhi extract (.osm.pbf)      Mapillary street-light detections + photo coverage
        │  pipeline/fetch.py                                  │  pipeline/fetch_mapillary.py (optional)
        ▼                                                     ▼
pipeline/build_graph.py ── safety_model.py (features → risk per time band)
        │   walkable ways → junction graph (largest component)
        │   + POIs, street lamps, CCTV, police, stations, land-use polygons, street names
        │   → per-segment risk[day, evening, night] + explanation features
        ▼
web/data/  graph.bin.gz (≈256k junctions, 355k segments, 23,000 km of streets)
           names.json · places.json (2,091 safe places) · meta.json · boundary.json
        │
        ▼
browser:  router.worker.js  A* routing, turn instructions, walking distances
          app.js            MapLibre map, planner, route explanation
          nav.js            GPS turn-by-turn navigation, voice, rerouting
          safety.js         safe places near me, share my location
          demo.js           simulated GPS walk, only with ?demo
          sw.js             offline support (network first)
```

**Edge cost** = `length × (1 + α × 4 × risk[band])`. α = 0 gives the shortest path; α = 1 accepts up to 5× the length to avoid the riskiest segments. The A* heuristic is straight-line distance, which stays admissible because cost ≥ length. A 40 km cross-city route takes about 50 ms.

**Risk features** (see [`pipeline/safety_model.py`](pipeline/safety_model.py) for the weights):

| Raises risk | Lowers risk |
|---|---|
| Road type: paths, tracks, alleys and service roads over main roads | Places likely to be open in that band (shops, eateries, pharmacies, fuel stations, hospitals, hotels), using `opening_hours` when tagged |
| Darkness: `lit=no`, or a low lighting prior for the road type (evening and night only) | `lit=yes` tags, mapped street lamps, and street lights detected in Mapillary photos |
| Share of the segment inside parks, forest, farmland, industrial land, cemeteries, construction sites | Police within 250 m |
| Running alongside large (over 2 ha) isolated areas | Metro/rail stations within 200 m (day and evening) |
| Underpasses and tunnels, foot overbridges at night | Inside residential or commercial areas; CCTV nearby |

This measures the **street environment**, not crime. Delhi Police doesn't publish geocoded incidents. Mapping individual sexual-assault locations would also risk identifying victims (BNS §72).

## Run locally

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python pipeline/fetch.py        # ~27 MB download
.venv/bin/python pipeline/fetch_mapillary.py  # optional, needs a token (see below); ~1 min
.venv/bin/python pipeline/build_graph.py  # ~10 s
python3 -m http.server 8000 --directory web
```

Then open http://localhost:8000.

### Mapillary street lights (optional)

Mapillary detects street lights in its street-level photos. With a free client token, the build uses those detections: a light seen within 25 m makes a segment count as lit, and a segment photographed densely with no light seen gets a lower lighting estimate. Segments without photos are left alone. Missing detections only count as evidence where photos exist.

1. Register an app at https://www.mapillary.com/dashboard/developers (Read access) and copy the **Client Token**.
2. Local builds: `pbpaste > .mapillary_token` (git-ignored).
3. CI: `gh secret set MAPILLARY_TOKEN < .mapillary_token`.

Coverage in Delhi is thin for now (Sept 2026): photos cover about 12% of main roads and 2% of other streets, mostly central Delhi. The weekly rebuild picks up new photos automatically. **Capturing your own walking routes with the Mapillary app, including at night, directly improves this map.**

## Demo mode (for recording videos away from Delhi)

Open the app with `?demo`: https://vesuvius13.github.io/delhi-safe-routes/?demo

- You "are" at the start of whatever route you plan, anywhere in Delhi.
- **Start** walks you along the route at 5× walking speed, with turn prompts, voice and rerouting. `?demo=10` walks at 10×.
- **Safe places** and **Share** use the simulated position. Shared messages are marked as a demo.
- A yellow **DEMO · simulated location** badge stays on screen, so recordings can't be mistaken for a real walk.

Without `?demo`, nothing changes: the app uses real GPS.

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

- **Lighting data is sparse.** Only about 2,100 segments are tagged `lit=yes`, about 1,500 street lamps are mapped, and Mapillary photos cover about 4% of walkable streets, so lighting elsewhere is inferred from road type. A detected light pole also doesn't prove the light works at night. Opening hours are usually defaulted by category. Outer Delhi (Narela, Bawana, Najafgarh) has fewer mapped shops, so scores there lean on road type.
- Only about 14% of street segments are named in OSM (most colony lanes aren't), so directions often say "the street" or "the footpath" instead of a name.
- Walking in both directions is assumed. Gated colonies that close at night aren't known unless tagged `access=private`.
- The weights are priors, not yet calibrated against ground truth.
- Search depends on the public Photon API. If it's down, tapping the map still works.

## Roadmap

- [x] Street lights from Mapillary detections
- [ ] Activity (open shopfronts, people) from street imagery with a CV model
- [ ] Night-lights raster (VIIRS) as a coarse lighting layer
- [ ] "Was this route OK?" feedback, and calibrating weights against Safetipin audit data
- [x] Nearest safe place right now and one-tap location sharing
- [ ] Live location tracking (needs a small backend)
- [ ] Hindi UI

## Data and credits

Street data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL), via [openstreetmap.fr extracts](http://download.openstreetmap.fr/extracts/asia/india/). Street-light detections © [Mapillary](https://www.mapillary.com) (CC BY-SA 4.0). Map tiles: OpenFreeMap / OpenMapTiles. Map library: MapLibre GL JS. Search: Photon by komoot.
