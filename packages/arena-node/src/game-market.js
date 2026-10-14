// A MARKET ON A GAME AT A SEAT (kanban #362 feature 6; protocol 2026.0.6): THE NODE HOOK. A market round of a game market
// (manifest.js `gameSource`) is decided by its source round's own signed result, never by an attestation (attested.js refuses
// one for it). This is where a seat checks such a result: the market round and its source round as THIS seat holds them, the
// source's settlement committee as THIS seat's roster draws it from the census and the beacon (never the contract's `nodes`,
// which a round id does not hash from version 2), and the protocol's verification (game-market.js gameMarketResolution) - the
// same count of the same signatures a page makes for the source round itself (arena-client round-verdict.js).
//
// WHAT IT DOES NOT DO YET (named, so nothing reads more into it): it holds nothing and settles nothing. The resolution it
// answers is not written as the round's outcome, the attested settlement (settlement.js #attestedOf) does not read it, and a
// FLAT refund is not turned into an early VOID - a market on a game still goes VOID by attested.js marketVoided at its
// deadline when no outcome is held. And a seat that does not hold the source round (the market's 7 seats are another draw
// than the source's) refuses rather than fetching the source's contract from its seats.
import { decodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { isGameMarket } from '../../arena-protocol/src/manifest.js';
import { gameMarketResolution, gameMarketVoided } from '../../arena-protocol/src/game-market.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { pluginForRound } from './plugins.js';

const refuse = (why, status = 409) => ({ ok: false, status, why });

/**
 * `round` the seat's store (get(id) -> { contract }), `plugins` the games it hosts (pluginForRound's map), `committeeFor(id,
 * role)` the roster's draw ({ ok, committee: [{ pubkey }] }), `verify` BIP-340, `now()` the seat's clock. Answers
 * `resolveGameMarket(marketRoundIdBytes, { openCents, closeCents, front?, sigs })`: the protocol's resolution of the market
 * round from its source round's RoundResult and the seats' signatures over it (the shape GET /round-result answers, one
 * { key, signature } per seat), with `voided` - whether the market is VOID on this seat's clock - and the source round's id;
 * or a refusal by name with an HTTP status.
 */
export function gameMarketHook({ round, plugins, committeeFor, verify, now = () => Date.now() }) {
  return function resolveGameMarket(marketRoundIdBytes, { openCents, closeCents, front, sigs } = {}) {
    const row = round.get(marketRoundIdBytes);
    if (!row) return refuse('this seat holds no such round', 404);
    const market = decodeRoundContract(new Uint8Array(row.contract));
    const found = pluginForRound(market, plugins);
    if (!found.ok) return refuse(found.why);
    const manifest = found.plugin.manifest;
    if (!isGameMarket(manifest)) return refuse(`game "${manifest.gameName}" is no market on a game: its outcome is not a source round's result`);
    const sourceHex = toHex(market.sourceRoundId);
    const sourceRow = round.get(market.sourceRoundId);
    if (!sourceRow) return refuse(`this seat holds no source round ${sourceHex.slice(0, 16)}: it checks a market on a game only against a source round it holds`, 404);
    const source = decodeRoundContract(new Uint8Array(sourceRow.contract));
    const picked = committeeFor(market.sourceRoundId, 'settlement');
    if (!picked || !picked.ok) return refuse(`no settlement committee of source round ${sourceHex.slice(0, 16)} is drawn here: ${(picked && picked.why) || 'no roster'}`);
    const committee = picked.committee.map((e) => e.pubkey);
    // THE SOURCE IS THIS SEAT'S OWN COPY: a series round is held only as its series derives it (POST /round's series refusal), so
    // its times are the series' even though its id H(series_id || i) does not hash them
    const resolution = gameMarketResolution({ market, manifest, source, committee, verify, sourceHeld: true,
      result: { roundId: market.sourceRoundId, openCents, closeCents, ...(front !== undefined ? { front } : {}) }, sigs });
    const voided = gameMarketVoided(resolution, { market, manifest, nowMs: now() });
    return { ...resolution, source: sourceHex, voided: voided.voided, ...(voided.voided ? { voidWhy: voided.why } : {}) };
  };
}
