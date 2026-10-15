# What the protocol needs for more games and prediction markets

Kanban #362 (the owner 2026-10-14 ~20:45Z): "research on what the protocol would need for further games and prediction markets. Be
creative, what features do we need to really make an attractive platform. Think of it and think hard. Then implement those
features."

## 1. What the protocol already has (main, 2026-10-14)

| Area | Today |
|---|---|
| Game kinds | `REPLAY` (deterministic skill game, every run replayed by the committee), `ATTESTED` (2-16 outcomes, 1-16 attestors, k-of-n), `HEAD_TO_HEAD` (2-16 players, commit-reveal moves) |
| Payout rules | `RANK_CURVE` (§18A, replayed runs), `PARI_MUTUEL` (attested outcomes); head-to-head: winner takes the table |
| Markets | per-manifest question, fees (node, donation), resolve time, deadline, source rule; an order book cleared in batches (Up/Down) |
| Money | Fedimint stake locks in two federations, Lightning in and out, donations to protocol and game devs, node fee shares |
| Trust | bonded census, sortition committees (5 of 7), replay objection window, slashing, versioned protocol |
| Distribution | signed manifests hosted by any node, plugin store, owner area, Nostr login, our relay, NWC |
| Presentation | a per-round leaderboard derived from signed results (presentation, not authority) |

## 2. What is missing for an attractive platform

Who must want to come: **players** (fun, prizes, status, friends), **game developers** (reach, revenue, easy tooling), **market
creators** (any question, liquidity, fees), **node operators** (fees, low effort). Each gap below names whom it serves.

| # | Feature | Serves | Why it matters | Size |
|---|---|---|---|---|
| 1 | **Seasons and cross-round leaderboards** | players, devs | Status over time is what brings players back; a round board is forgotten after the round. Deterministic, from signed FINAL results only | S |
| 2 | **Results on Nostr** (each node publishes FINAL results and season boards as signed events) | players, devs | "Share my win" travels with the player's Nostr key; clients, bots and other sites can follow a game without our page; it fits "Nostr native" | S |
| 3 | **Top-N prize splits** (e.g. 50/30/20, winner-takes-all) as a payout rule a manifest picks | devs, players | Tournament-style games need fixed splits; the rank curve is one shape only | M |
| 4 | **Sponsored prize pools** - anyone adds sats to a round's or a season's pot, paid only to winners | players, devs, brands | Freerolls with real prizes are the strongest acquisition tool there is; devs can launch with a pot; refunds if the round is void | M-L |
| 5 | **Event markets from templates** - a manifest is a template (attestors, terms, category); each round carries its own question, outcome labels and resolve time | market creators | Today every new question needs a newly signed manifest; with templates anyone opens "Will X happen by Y" in one transaction | M |
| 6 | **Markets on games** - an attested market whose outcome is a game round's signed result (e.g. BULLS vs BEARS of a Tick Tock round, the winner of an RPS table) | spectators, devs | Turns every game into a spectator sport with no external oracle: the committee's 5-of-7 RoundResult resolves it | M |
| 7 | **Frontend (referrer) fee** - a capped share of the fee for the page that brought the entry | integrators | Third-party frontends, wallets and Nostr clients become distribution; a growth loop without a central company | M |
| 8 | **Scalar markets** - a numeric outcome (a price, a count) paid linearly between bounds | market creators | Richer questions than buckets; one market instead of many | M |
| 9 | **Liquidity for markets** (LMSR market maker with a creator-funded, bounded subsidy) | market creators, players | A market with no counterparty is dead; LMSR always quotes a price, and the creator's loss is capped | L |
| 10 | **Tournaments** - one entry, many rounds (swiss or bracket), a prize pool at the end | players, devs | Events, streams and community nights | L |
| 11 | **Hidden-information games** (cards) via the committee's threshold key: the deck is encrypted to the committee's FROST/DKG key and cards are revealed by threshold decryption to their holder | devs | Poker, blackjack and every card game; uses keys the committees already hold | L |
| 12 | **Turn-based async games** (chess, board games): per-move deadlines, moves posted to seats or Nostr | devs, players | A large family of games the commit-reveal shape cannot carry | L |
| 13 | **Achievements and badges** (NIP-58) awarded from signed results | players | Collectible status on the player's own Nostr identity | S-M |
| 14 | **Zaps between players** and tips to devs (NWC) | players, devs | Social money; tips without a custodian | S |
| 15 | **Developer devnet** - one command starts a local chain, a federation and seven nodes, with a game template and a replay simulator | devs | The first hour decides whether a developer stays | M |
| 16 | **Progressive jackpots** - a slice of fees accumulates across rounds for a rare event (a perfect run) | players | Excitement; needs cross-round custody | L |

## 3. Order of building

1. **Seasons and cross-round leaderboards** (1) - protocol function + node door, presentation only, no money path.
   State: built. `GET /season` is one node's board from its own store; `GET /season-rounds` hands out the rounds it is built
   from; `GET /season?scope=network` asks every seat it knows for theirs and counts a round only when 3 distinct seats hand
   in byte-identical accounts of it (protocol `mergeSeasonAccounts`, `SEASON_NETWORK_AGREE`): an honest FINAL round sits in
   at least 5 committee seats, and forging one takes 3 colluding seats. The testnet page shows it: a "Season" link on each
   game's tile, a Season button beside the gear and on the wallet bar once a game is chosen; the board of the last 7, 30 or
   90 days from the game's first seat that answers `?scope=network`, the viewer's own row marked, asked again every 30 s
   while open (arena-client `season-view.js`). `/season-rounds` also names each entry's round key (`roundKeys: true`),
   which the weekly top-3 badge (13) merges on; the network board does not read it.
2. **Results and season boards on Nostr** (2) - nodes publish what is already signed; the relay accepts the event kind.
3. **Top-N prize splits** (3) - a new payout rule; only manifests that pick it are affected, every existing game id unchanged.
4. **Event-market templates** (5), then **markets on games** (6) - the composability unlocks.
   Markets on games (6): State: built (protocol 6, dormant until seats advertise 6). A manifest names its source game, the
   result kind (Tick Tock's §13 RoundResult) and a mapping onto its outcomes (marker 0x05, no attestors); each round names its
   source round (contract tail 0xc4, version 6 only). Resolved only by the source round's own result, signed by its settlement
   committee's threshold (5 of 7); entries close before the source starts; FLAT, a misfit source or no result by the
   deadline is VOID. RPS is not a source kind yet: it signs per-entry results, no table winner. Node side built: a seat
   holds a standing source result where an attestation is held (RoundResult bytes, the committee's signatures, the source
   contract) and settles the market as an attested one (pari-mutuel, after the objection window); FLAT and a misfit source
   are VOID at once; its own sweep asks the source's committee once the source has ended (each stored round looked at
   once); a seat without the source fetches its contract from other seats and checks it against the id itself.
   `POST /game-outcome` hands a result in. Left: the page's market lines (multiplayer_p2p.md §0A.7d).
5. **Sponsored pots** (4) and **frontend fees** (7) - money paths, each with its own tests and a regtest rehearsal.
6. Then 8-16 by demand.
   **Developer devnet** (15). State: built. `node packages/arena-node/tools/devnet.mjs up | status | play | replay | down`, everything
   in one directory (DEVNET_DIR) on ports derived from one base (DEVNET_BASE_PORT, default 24000; all below 32768, none of the
   live stacks', refused by name when taken). `up` reuses the harnesses: a regtest bitcoind, the federation founded by
   `testnet4-found.mjs` (seven nodes, each one guardian, 5 of 7), seven `src/main.js` nodes, two lnds with a gateway each
   (`testnet4-gateway.sh`, registered at every guardian), and `round-2of2.mjs` standUpRound attached with
   ARENA_POST_FIRST_BONDS - the bonds, a free and a paid round, and a keeper. `play` drives one headless entry through a fresh
   free round (tn4-live-run's run without the lock) and prints every node's signed result; `replay` is the replay simulator
   (the node's own replay, in the core's sandbox, over a node's transcript and marks); `down` stops what it started by its pid
   files. The game template (`tools/devnet-template`, `devnet.mjs new-game <dir> <name>`) is a whole replayed game - core,
   manifest body, registration - signed with the developer's own keys by the dev client and hosted with DEVNET_GAMES; `play
   --game <name>` plays it end to end. Measured on the test host: `up` 75 s from empty, `play` 229 s (Tick Tock) and 157 s
   (the template), 7 of 7 signatures, `replay` agreeing with all seven. Left: the paid round is published but the gateways
   hold no channels or e-cash, so no deposit goes through; the browser link is printed, not tested.
   **Achievements and badges** (13). State: built (off by default: ARENA_NOSTR_BADGES). Protocol `badges.js` holds a fixed,
   versioned catalogue - first win, five rounds, perfect run (a staked Tick Tock run of 1000 points or more), season top 3
   (a closed Monday-to-Monday UTC week's board, at least 3 players) - and `badgesEarned`, which reads every round through
   `season()`, so a badge agrees with the season board. A seat reads each round once its settlement is ACCEPTED (the
   moment its Nostr result is built) and each closed week once, and signs NIP-58 events with its node key: a Badge
   Definition (kind 30009) per badge and a Badge Award (kind 8, `a` = `30009:<seat>:<d>`, `p` = the player's identity,
   `evidence` = the round ids) once per badge, player and game (or week), kept across restarts. Only an identity key (an
   x-only Nostr key) is awarded, never a bare round key. The season top 3 ranks THE NETWORK'S week, not the seat's own
   (one seat holds only its committees' rounds, about half): 2 h 15 min after the week closes the seat asks every seat
   it knows for the week's `/season-rounds` and merges them with protocol `mergeSeasonAccounts` (3 seats agreeing byte
   for byte, round keys included - `keys`), so seats that read the same agreed rounds award the same podium; with fewer
   than 3 seats answering the week waits, asked again every 30 min for up to 2 days; the award names the week, the
   rank, the seats that answered and the 3 that had to agree (`seats`, `agree` tags). `GET /badges?player=`,
   `GET /badge-definitions`; published with the results to ARENA_NOSTR_PUBLISH; the Arena relay takes kinds 30009 and 8.
   The testnet page shows them on the season board: each row's badges in the shown game as small icons after the name
   (the seat's `/badge-image/<d>.svg`, else a built-in glyph; the name and what earned it on hover or tap) and "Your
   badges: N" under the header - the board's seats asked once each which award badges (`on: true`), each player on
   screen once per badge seat for the board's life, the awards merged by (d, scope) (arena-client `badges-view.js`).
   Not yet: the round badges (first win, five rounds, perfect run) still read the seat's own rounds.

Rules for every feature: additive, versioned where it changes bytes (§#349 required versions), no change to any existing
game or market id, tests first, measured live before it is called done.
