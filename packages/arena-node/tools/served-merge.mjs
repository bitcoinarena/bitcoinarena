// served-merge.mjs <to ms> <seat url>...: kanban #365 - who served a round in the 24 h before <to>, from EVERY seat's FINALs: each seat
// holds only the rounds it sat on (GET /served?finals=1), so they are merged by round (protocol mergeServedRounds) and counted once,
// every FINAL checked here against its committee and its BIP340 signature
import { schnorr } from '@noble/curves/secp256k1.js';
import { servedNodes, mergeServedRounds, SERVED_WINDOW_MS } from '../../arena-protocol/src/served-nodes.js';
import { fromHex } from '../../arena-protocol/src/hash.js';
const [to, ...seats] = process.argv.slice(2);
const held = [];
for (const s of seats) {
  try {
    const a = await (await fetch(`${s.replace(/\/$/, '')}/served?to=${to}&finals=1`, { signal: AbortSignal.timeout(30000) })).json();
    held.push((a.held || []).map((r) => ({ roundId: fromHex(r.roundId), committee: r.committee.map(fromHex), finals: r.finals.map(fromHex) })));
    console.error(`${s}: ${a.rounds} round(s), root ${a.root.slice(0, 16)}`);
  } catch (e) { console.error(`${s}: ${e.message}`); }
}
const merged = mergeServedRounds(held);
const got = servedNodes({ rounds: merged.rounds, fromMs: BigInt(to) - BigInt(SERVED_WINDOW_MS), toMs: BigInt(to), verify: (sg, m, k) => schnorr.verify(sg, m, k) });
console.log(JSON.stringify({ seatsAnswered: held.length, rounds: got.rounds, nodes: got.nodes, root: got.root, refused: got.refused.length, conflicts: merged.conflicts }));
