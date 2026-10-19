# Tick Tock, Next Block - the game's mark

The source of the game's name and mark everywhere a player sees them. Served beside the page (the WebGL template
`src/arena-ui` carries byte-equal copies; `test/brand.test.js` holds them equal), pinned
per file in `arena-client/known-good-clients.json` under `games.nextblock`, and named by hash in nextblock's signed
manifest (`clients`, spec §0A.3) - a second game brings its own.

- `nextblock-icon.svg` - the square icon: a clock on the page's dark ground (#0d1014) in the bitcoin orange (#f7931a),
  its hour hand a block. Reads at 16 px (favicon).
- `nextblock-wordmark.svg` - the icon beside "TICK TOCK," (white) / "NEXT BLOCK" (orange).
- `favicon.ico` (16, 32, 48), `apple-touch-icon.png` (180), `nextblock-icon-192.png`, `nextblock-icon-512.png` (PWA,
  `site.webmanifest`), `nextblock-og.png` (1200 x 630, the link preview; drawn from `og.html`).

The PNGs and the ICO are rendered from the SVGs with headless Chrome (`--screenshot` at each size) and PIL for the ICO.
