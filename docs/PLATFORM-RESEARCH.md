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
2. **Results and season boards on Nostr** (2) - nodes publish what is already signed; the relay accepts the event kind.
3. **Top-N prize splits** (3) - a new payout rule; only manifests that pick it are affected, every existing game id unchanged.
4. **Event-market templates** (5), then **markets on games** (6) - the composability unlocks.
5. **Sponsored pots** (4) and **frontend fees** (7) - money paths, each with its own tests and a regtest rehearsal.
6. Then 8-16 by demand.

Rules for every feature: additive, versioned where it changes bytes (§#349 required versions), no change to any existing
game or market id, tests first, measured live before it is called done.
