# Bitcoin Logistics War — Bulls & Bears Delivery Front

A real-time 3D browser game where the **live Bitcoin price chart is the battlefield** and **real
unconfirmed mempool transactions are your cargo**.

You are the Logistics Commander. Load pending transactions onto armoured mail trucks, pick a route
across a warzone that redraws itself every time the price moves, and get your packages through the
Blockchain Gate before the next real block is found.

```
open http://localhost:8080     # after starting a static server, see "Running" below
```

## What is actually live

| In the game | Real source |
| --- | --- |
| Terrain shape, frontline position | `btcusdt@aggTrade` / `@ticker` — Binance spot |
| Troop strength, unit density | live trade flow imbalance (buys vs sells) |
| Translucent ramparts near the seam | `btcusdt@depth20@100ms` order book |
| Airstrikes and craters | `!forceOrder@arr` — Binance futures liquidations |
| Every package | `mempool.space/api/mempool/recent` — real unconfirmed txs (txid, vsize, fee, value) |
| Package colour / tier | fee rate vs. the *current* next-block median from `/v1/fees/recommended` |
| Block found → convoy, confetti, ×3 window | mempool.space websocket `blocks` |
| Block height, miner, tx count, total fees | mempool.space block payload |

If any socket is unreachable (geo-block, offline, corporate proxy) the game **transparently falls
back to a simulator** — mean-reverting price walk, synthetic order book, Poisson blocks at a 10 min
mean, plausible fee distribution — and switches back to live the moment the socket returns. The
status pills top-left always say which mode each feed is in.

## Running

It's a static site with no build step. Any static server works:

```bash
python3 -m http.server 8080        # then open http://localhost:8080
# or
npx serve .
```

`three.js` is vendored in `vendor/` so the whole folder is self-contained and deployable to any
static host (GitHub Pages, Netlify, S3) by copying it as-is. Opening `index.html` via `file://`
will **not** work — ES modules need a real origin.

## Controls

| Key | Action |
| --- | --- |
| `1` – `6` | camera: cinematic · god · follow · plaza · driver · free |
| Click / drag | select package · drag a box to multi-select |
| Double-click | load that package straight onto the selected truck |
| `Space` | auto-load the highest fee-rate packages that fit (greedy, like a real miner) |
| `L` | load the current selection |
| `Z` / `X` / `C` | route: Bull Flank · Frontline · Bear Flank |
| `Enter` | dispatch the convoy |
| `B` | boost (burns banked fees) |
| `P` | repair |
| `R` | RBF-bump selected packages to VIP |
| `Tab` | cycle trucks |
| `WASD` | free camera, or steer while in follow/driver mode |
| `E` | field manual · `M` mute · `Esc` clear selection |

Mobile: tap to select packages and trucks, use the on-screen quick-action bar.

## Gameplay

1. Packages pile up in the **Sorting Plaza** at the rate the real mempool produces transactions.
   Size = vsize, colour and glow = fee rate *relative to what the next block is paying*. Low-fee
   packages visibly sulk. ≥50 BTC transactions arrive as whales.
2. Fill a truck. Capacity is in vB — your truck is a block template, and the same greedy
   fee-rate knapsack a miner solves applies.
3. Pick a route. All three are **visible streets** you can watch your truck drive down: two
   winding flank highways with kerbs and centre lines that climb over the hills, and the
   Frontline road, which is redrawn every frame because it follows the live price. They fan out
   of the plaza and converge again on the Blockchain Gate. The Bull Flank is safe and pays ×1.0;
   the Frontline pays ×2.6 while under fire from both sides.
4. Survive the crossing. Every liquidation scrambles a **bomber**: it flies in from off-map
   trailing contrails, runs over the target, releases a bomb that falls ballistically (with the
   whistle), then banks away while the blast craters the terrain, damages trucks and scatters
   cargo. Some packages RBF themselves back to the mempool out of sheer self-preservation.
5. Deliver through the Blockchain Gate. When a **real block** is found: bass drop, confetti,
   armoured convoy parade, and a ×3 scoring window for 25 seconds. Any packages in the plaza paying
   above that block's median fee get confirmed without you — because that is what actually happens.
6. Banked fees buy boosts, repairs, RBF bumps and better trucks.

## Modes

- **Commander** — the full game.
- **War Room** — pure spectator. Hides the player chrome and just runs the visualisation, driven
  entirely by live data. Cinematic camera, killfeed, the whole war.

## Layout

```
index.html          HUD markup + import map
styles.css          HUD / panels / responsive
vendor/             three.js r169 (vendored, MIT)
src/
  main.js           boot + render loop
  game.js           orchestration, scoring, progression, block events
  config.js         every tunable number
  feeds.js          Binance + mempool.space, reconnection, simulation fallback
  audio.js          all SFX synthesised with WebAudio (no assets)
  input.js          picking, box select, hotkeys, touch, manual driving
  ui.js             HUD binding, minimap, order book canvas, tooltips, field manual
  render/scene.js   renderer, sky, market-driven atmosphere, 6 camera modes
  render/fx.js      pooled GPU particles, ballistic rounds, shockwaves, floating text
  render/geom.js    model kit — merges multi-part models into one vertex-coloured
                    geometry so a whole army is a single instanced draw call
  world/battlefield.js   price-chart terrain, frontline, units, order book, bomber raids
  world/roads.js         the three visible routes + the mountains they wind through
  world/logistics.js     plaza, packages, fleet, routes, depot, convoys
```

Rendering notes: soldiers (helmet, pack, rifle) and tanks (hull, turret, barrel, tracks, road
wheels) are built from ~15–25 primitives each, then baked down to one geometry with vertex
colours. Team colour rides on `instanceColor` and multiplies with the baked colours, so a
near-black rifle stays near-black on both a green and a red soldier — 500 units, two draw calls.
Mountains are static, so they are baked into the terrain's base height once rather than evaluated
per vertex per frame.

## Notes on accuracy

The educational claims in the field manual (`E`) are the real mechanics: fee *rate* not total fee
decides queue position, ~1M vB per block, RBF, why liquidations cascade, what order book walls are.
The scoring model deliberately mirrors a miner's incentive — fill the template, prefer high fee
rate, and race the next block.

Not financial advice. It's a game about mail trucks.
