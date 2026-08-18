# External assets

All files under `vendor/assets/` are **CC0** (public domain) from
[polyhaven.com](https://polyhaven.com). No attribution is required; it is
recorded here anyway.

| Path | Asset | Use |
|---|---|---|
| `hdri/quarry_cloudy_1k.hdr` | Quarry Cloudy | Captured sky, turned into the scene light probe — what puts real sky detail into every reflection |
| `textures/asphalt_02/` | Asphalt 02 | Road surfaces (albedo, normal, ORM) |
| `textures/brown_mud/` | Brown Mud | Terrain relief — normal and roughness only, the albedo stays with the territory vertex colours |
| `models/concrete_road_barrier/` | Concrete Road Barrier | Roadside barriers |
| `models/old_military_crate/` | Old Military Crate | Supply dumps along the routes |
| `models/barrel_03/` | Barrel 03 | Frontline clutter |

Total ~15 MB at 1k. Everything loads asynchronously and swaps in over the
procedural stand-ins when it arrives, so the game is playable from the first
frame and simply improves a second later — and still runs if the files are
missing entirely.

`vendor/addons/` holds stock three.js example modules (postprocessing, loaders,
RoundedBoxGeometry), MIT licensed, same as three.js itself.
