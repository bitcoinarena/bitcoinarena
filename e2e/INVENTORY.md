# E2E inventory (kanban #2642)

Every user-facing and node-facing function of the 1.9 line (origin/interim-2026.1.9.17), read from the code: `src/arena-ui` (the page and
its sub-pages), `packages/arena-web/src` (the React parts), `packages/arena-client/src` (the page's client), `packages/arena-node/src/server.js`
(the seat's doors) and `tools/faucet.mjs`, the games of `apps.lock.json`, `packages/arena-installer`. Each line names the e2e flow that
drives it (`e2e/flows/*.mjs`), or why none does. `[x]` = a flow exists, `[ ]` = not covered (the reason is given).
Money first, then reach, as the suite runs them.

## Money: wallet, deposits, withdrawals, rounds that pay

- [x] Create a wallet (24 words shown) - `wallet.create-and-verify`
- [x] Seed check (3 of 24 words from memory), backup warning cleared - `wallet.create-and-verify`
- [x] Restore a wallet from its 24 words in another browser, balance comes back - `wallet.restore-from-words`
- [x] Reload keeps the wallet and its balance - `wallet.reload-keeps-balance`
- [x] Lightning deposit: invoice made through a federation gateway (LNv2), paid by an lnd, balance shown - `deposit.lightning`
- [x] Lightning withdrawal to an outside invoice, balance drops - `withdraw.lightning`
- [x] Two live gateways of two operators registered at every guardian (precondition of every paid round, §23.6) - `lightning.gateways-live`
- [x] Open a paid round (10 000 sat) - listed at the seats with its stake - `round.paid.open`
- [x] Paid entry end to end with the page's own wasm lock client: deposit, stake + fee locked in the federation, played, handed over to 7 seats, settled, payout withdrawn - `round.paid.headless-entry` (tools/tn4-live-run.mjs: the page's lock client and join code in Node; see "page-driven joins" below)
- [ ] Paid entry pressed in the page (Unity PLAY on a paid row) - not drivable on a private regtest chain: see `round.free.page-join`
- [x] Players' faucet: welcome grant and top-up over Lightning, refusals (second welcome, reused invoice, wrong amount) - `faucet.player-grant`
- [x] Welcome grant asked by the page on "Create a new wallet", paid into the page's wallet - `faucet.page-welcome`
- [ ] Welcome as pooled e-cash - no e-cash pool configured on the devnet
- [x] Faucet: coins to an address, the book's limits (same address, amount caps, day cap) - `faucet.coins` (faucet service: `faucet.service-up`)
- [x] Bounty payout of an approved report over LNURL-withdraw (LUD-03), wrong k1/amount/network refused, one claim only - `bounty.lnurlw-claim`
- [ ] Bounty paid to a Lightning address - needs a public HTTPS wallet
- [ ] NWC deposit (Nostr Wallet Connect, `nwc.js`) - needs a NIP-47 wallet service on a Nostr relay; none runs on the devnet (public relays are blocked)
- [ ] WebLN deposit - needs a browser wallet extension
- [ ] E-cash move between two of the player's wallets / federations (`ecash-transfer.js`, MovePanel) - the devnet has one federation
- [ ] Item purchase (`item-buy.js`, ShopItems; POST /item-purchase) - nextblock's items are bought with a funded wallet and a sealed manifest; not built
- [ ] Liquidation claims, stake-back, slash collection (`liquidation-claim.js`, ARENA_COLLECT_SLASH) - need a slashed seat; not built
- [ ] Zap a player (`zap.js`, ZapCard) - LNURL zap to a public Lightning address
- [ ] Donations (DonateBox, POST /donation-gift) - pay to the developers' set: drivable later, not built
- [ ] Referral payout at settlement (FRONTEND_PK through tn4-live-run) - not built (the referral reads are)

## Rounds and games

- [x] Free Next Block round played to its signed result (7 of 7 agree with the local drive) - `round.free.headless-play`
- [x] Replay of a played entry from a seat's transcript - `round.replay`
- [x] The page lists the open rounds (lobby rows checked against their contracts) - `page.boot`
- [ ] Press PLAY on a free round in the page - `round.free.page-join`: covered as far as the page goes; on a private chain the page cannot prove a seat's bond (compiled-in anchors; the devnet's shared bond proof)
- [ ] Rock Paper Scissors rounds (free, paid, tables) - the devnet hosts nextblock only unless DEVNET_APPS names RPS at the first `up`; not in this run
- [ ] Up or Down rounds and markets (btc-updown, attested price) - needs the game in DEVNET_APPS and price attestors; not in this run
- [ ] Two players in one round, ghosts, head-to-head (two tabs) - the page join is not drivable here (above)
- [x] `/games/btc-updown/` page loads - `page.sub.games-btc-updown`

## Markets

- [x] Market rounds door answers - `markets.reads`
- [ ] Buy / sell an outcome (`market.js`, /sell, order batches), scalar markets - no market game on the devnet

## Leaderboard, season, badges

- [x] Season board (seat and network scope), season rounds, badge definitions, a player's badges - `season.board-and-badges`
- [x] Leaderboard button in the page opens the board - `leaderboard.page`

## Identity and settings

- [x] Nostr login with an nsec, kept over a reload - `nostr.login-nsec`
- [ ] Nostr login by extension (NIP-07) or phone signer / bunker (NIP-46) - need an extension or a signer on a relay
- [x] Player name saved, kept over a reload - `settings.name`
- [ ] Graphics, logs, rescan, delete account, seed re-show (settings panel) - not built

## Feedback, bounty, community

- [x] Feedback report from the page (signed Nostr event, kind 27842), "My feedback" (NIP-98) - `feedback.page-signed`
- [x] Feedback without a wallet: posted, not kept - `feedback.page-unsigned`
- [x] Screenshots: kinds, sizes, admin-only read - `feedback.screenshot`
- [x] Admin review list / act / CSV, approval bands, one approval - `bounty.admin-review`
- [x] Community check against fakes (forged signature, edited content, other key, replays, stale/future events, bad addresses, secrets scrubbed) - `feedback.fakes`
- [x] Season 2 / Week 2 bounty: pot, link codes behind NIP-98, approvals per band - `bounty.season2`
- [ ] Week 2 social readers (X, Telegram, Discord, Armada) - public services, none configured

## Proposals and ballot

- [x] Proposals and the ballot's live config, one config hash at every seat - `proposals.ballot-reads`
- [x] `/proposals/` page loads - `page.sub.proposals`
- [ ] Publish a proposal and vote it through (ballot-tally on chain) - tools/ballot-regtest.mjs does it on main; not on this line's devnet run

## Referrals

- [x] Referral fees door; an unsigned referral name is refused - `referrals.name-and-fees`
- [x] `/referral/` page loads - `page.sub.referral`

## Owner page and operator

- [x] Owner actions refuse a stranger; owner reads are public - `seats.owner-door-locked`
- [x] Operator doors refuse a caller without a token - `seats.operator-door-locked`
- [ ] Owner login (words / key), roles, services, leave, bond withdraw on the owner page - needs an owner claimed on a seat; not built
- [x] `/dashboard/` page loads - `page.sub.dashboard`

## Explorer and public reads

- [x] Round, round result, results, transcript, census, committee, headers, replay - `explorer.round-reads`
- [x] Seats: identity, guardian, roles, census agreement - `seats.identity-and-roles`
- [x] Games, icons, network, fees, config - `seats.games-and-network`
- [x] `/guardians/`, `/health/`, `/platform/`, `/offline/`, `/wallet/` pages load - `page.sub.*`

## Node: installer, update, rollback

- [x] Wizard opens once per link, session and host checks - `installer.wizard-opens`
- [x] New seed, chain step (refuses a non-testnet4 chain), resume after a restart - `installer.start-new-seed`, `installer.chain-devnet`, `installer.resume-after-restart`
- [x] Roles and apps, seed words check, owner binding, emergency owner handoff - `installer.roles-apps`, `installer.seed-words`, `installer.emergency-owner-handoff`
- [ ] Reach check and service install - the reach seats are hard-coded live testnet4 seats; install writes into the Mac's real launchd (node 15)
- [x] Signed update (forged sums and wrong file refused), update, rollback of a failing release, downgrade guard, auto-update - `installer.update-cli-signature`, `installer.update`, `installer.rollback-failed-release`, `installer.downgrade-guard`, `installer.auto-update`
- [ ] Signed release download from GitHub - private releases, not on regtest

## Slash and fallback paths

- [ ] Forfeit, emergency departure, seat succession, slash proofs - tested by the rehearsal regtest tools (rehearsal-*.mjs), not in this suite
