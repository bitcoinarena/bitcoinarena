// A TESTNET4 HOLD THAT SETTLES ON A PREIMAGE THE SIGNER NODES REBUILD (§23.4, the owner 2026-09-21).
//
// WHAT THIS REPLACED, AND WHY. The first version of this tool held and settled three real invoices on the
// live pair and proved the hold path end to end - ACCEPTED -> HELD -> SETTLED/CANCELLED, with the msat and
// the channel totals recorded in TASKBOOK on 2026-09-20. But it handed the 32 bytes in:
//
//     const custody = new Custody(round, { port, preimageFor: (id, e) => preimageOf(e.pubkey[31]) });
//
// `preimageOf` fabricated them - 0xc0, the run's nonce, the player's number - so the settle proved lnd works
// and proved nothing about custody. One endpoint knew the secret and spent it. That is the single-node
// custody §23.4 exists to end, and both injection sites (the Custody above and the restart `maker`) are gone:
// NOTHING IN THIS FILE CAN PUT A FABRICATED PREIMAGE ON THE SETTLE PATH ANY MORE.
//
// WHAT IT DOES INSTEAD. Two real signer nodes, each with its own store and its own key, serving on loopback:
//   - the round names THEIR pubkeys as its settlement seats, not placeholders;
//   - the stake's preimage is dealt as a handout, so each seat holds one share and the entry publishes them;
//   - node A issues the hold on the live testnet4 lnd, B pays it from the other end of the real channel;
//   - the round closes with no first mark, which is FORFEIT (§15's walk-away), so the hold must SETTLE;
//   - and A settles it with bytes it does not have: `fromTheCommittee` (server.js:309) opens A's own share,
//     asks B over `GET /share?round=..&entry=..`, and reconstructs P. Fewer than the threshold and there is
//     no preimage at all, and the hold would sit in flight until it expired back to the player.
//
// TWO OF TWO IS NOT FIVE OF SEVEN, AND THIS DOES NOT PRETEND IT IS. `receiptsNeeded` (protocol/threshold.js)
// knows exactly two committee shapes - 2 slots need 2 shares, 7 slots need 5 - and throws for anything else.
// This pair is a 2-of-2: BOTH seats must answer, so it demonstrates that a settle is built from shares held
// by separate nodes over a real door. It does not demonstrate surviving the loss of a seat, which is what
// five of seven buys. The seven-seat shape is exercised in process by `five-of-seven.test.js`.
//
// THE CENSUS IS ASSUMED OUT LOUD. There is no live testnet4 census here, so each node is told who the round's
// seats are with `round.recordSignerNodes` - the same one-line assumption the in-process suites make, said
// rather than smuggled. Nothing else about assignment is faked.
//
//   node packages/blwp-node/tools/custody-testnet4.mjs            one real hold on the live pair
//   node packages/blwp-node/tools/custody-testnet4.mjs --dry      the same wiring against a fake port
//
// The dry run exists so the two-node reconstruction is proved before a sat is put at risk: it is the same
// code path with the Lightning port swapped, and it is how this tool was brought up without spending holds.
import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { lndPort } from '../src/lnd-port.js';
import { lndPreflight } from '../src/preflight.js';
import { feldmanGroup } from '../src/curve.js';
import { HELD } from '../src/custody.js';
import { DELIVERED, FORFEIT } from '../../protocol/src/payout.js';
import { TRUCK_CONFIG_HASH } from '../src/cores.js';
import { CORE_HASH } from './core-hash.mjs';
import { dealHandout, encodeHandout, handoutId } from '../../protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../protocol/src/shares.js';
import { encodeRoundContract, roundId as roundIdOf, encodeEntryContract, entryId as entryIdOf } from '../../protocol/src/contracts.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';
import { netStakeMsat } from '../../protocol/src/payout.js';
import { MIN_ENTRY_WINDOW_MS } from '../../protocol/src/constants.js';
import { NETWORK_ID_TESTNET4 } from '../../protocol/src/genesis-ids.js';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../protocol/src/donation.js';
import { receiptsNeeded } from '../../protocol/src/threshold.js';
import { BLOCK_TICKS, GATE_X } from '../../core/src/rules/gate.js';
import { init, step } from '../../core/src/sim.js';
import { CORE } from '../../core/src/adapter.js';
import { hash as stateHashOf } from '../../core/src/state.js';
import { seedWordForEntry } from '../../protocol/src/seed.js';
import { encodeInputBatch, batchId } from '../../protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../protocol/src/checkpoint.js';
import { GENESIS } from '../../protocol/src/transcript.js';
import { toHex, fromHex, sha256 } from '../../protocol/src/hash.js';

const LNCLI = process.env.BLWP_LNCLI || '/mnt/bitcoin/lnd-linux-amd64-v0.21.3-beta/lncli';
const A = { lnddir: '/mnt/bitcoin/lnd-testnet4', rpc: '127.0.0.1:11009', name: 'A lnd-testnet4' };
const B = { lnddir: '/mnt/bitcoin/lnd-testnet4-b', rpc: '127.0.0.1:11010', name: 'B lnd-testnet4-b' };
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const DRY = process.argv.includes('--dry');
const STAKE_MSAT = BigInt(arg('stake-msat', '1000000'));        // 1000 sat on a 200k sat channel
const NOW = Date.now();
const say = (s) => console.log(s);
const b32 = (n) => { const b = new Uint8Array(32); b[31] = n; return b; };
const rand = (n) => new Uint8Array(randomBytes(n));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A DRIVER THAT ACTUALLY ARRIVES, in the core's own units. The qualifier has to DELIVER: a round whose every
// entry is FORFEIT hands nothing out, and the settle refuses it - "the operator would keep 980000 msat". So
// the tool drives at the gate the core publishes (`GATE_X`), steering by the wrapped heading error, with the
// lead that stops a truck turning into the doorframe. It is the same rule `window-fixture` drives by, written
// here rather than imported, because a tool does not reach into the test fixtures.
const driveAt = (seedEntry, { lead, gain }, limit = BLOCK_TICKS) => {
  const ONE = 65536;
  const st = init(seedWordForEntry(seedEntry, BEACON.hash));
  const tape = [];
  for (let t = 0; t < limit; t++) {
    const p = CORE.picture(st);
    let off = Math.atan2(GATE_X / ONE + lead - p.x / ONE, -(p.z / ONE)) / (2 * Math.PI) - p.heading / ONE;
    off -= Math.round(off);                                     // the short way round, in turns
    const words = [ONE, Math.max(-ONE, Math.min(ONE, Math.round(off * gain * ONE))), 0, 0, 0];
    tape.push(words);
    step(st, ...words);
    const r = CORE.result(st);
    if (r.outcome) return { tape, ...r, at: t + 1 };
  }
  return { tape, outcome: null, score: CORE.result(st).score, at: limit };
};

// AND THE WORLD IS CHOSEN, NOT ASSUMED. The round's randomness is a real testnet4 block, so it is different
// on every run, and a world that delivered under one block wrecks under the next - measured: under
// 00000000bd4c..62a3 the fixture's own 0x5e secret ends FAILED at tick 336, while 0x55 DELIVERS at 993 with
// score 176. A player picks a world secret; this tool picks one that arrives under TODAY's beacon, by
// driving each candidate against the core before it joins anything. If none arrives, it says so and stops
// rather than joining a round it cannot finish.
const pickADeliveringWorld = (playerPubkey) => {
  for (let ws = 1; ws <= 0x60; ws++)
    for (const knobs of [{ lead: 10, gain: 6 }, { lead: 10, gain: 3 }, { lead: 20, gain: 6 }, { lead: 40, gain: 3 }]) {
      const got = driveAt({ playerPubkey, worldSecret: b32(ws), joinTick: 0 }, knobs, 1399);
      if (got.outcome === 'DELIVERED') return { worldSecret: b32(ws), knobs, ...got };
    }
  throw new Error('no world in the search delivered under this beacon - the round would have no qualifier');
};

/** A scalar the handout can split: 32 bytes below the field's order. */
const secretScalar = () => { let p = rand(32); while (scalarFrom32(p) >= FIELD) p = rand(32); return p; };

const flags = (n) => [`--lnddir=${n.lnddir}`, `--rpcserver=${n.rpc}`, '--network=testnet4'];
const lnj = (n, ...argv) => JSON.parse(execFileSync(LNCLI, [...flags(n), ...argv],
  { timeout: 60000, maxBuffer: 8 << 20 }).toString());
/** What this end of the one channel holds, in msat - the number a moved sat has to show up in. */
const localMsat = (n) => (lnj(n, 'listchannels').channels || [])
  .reduce((t, c) => t + BigInt(c.local_balance) * 1000n, 0n);

const until = async (what, f, ms = 240000) => {
  for (const stop = Date.now() + ms; Date.now() < stop;) {
    const got = await f();
    if (got) return got;
    await wait(1000);
  }
  throw new Error(`gave up waiting for ${what}`);
};

// A FAKE THE DRY RUN HOLDS ON. Same shape as `lnd-port`; it records what it was asked to settle, which is
// the whole point - the preimage under test is the one the port is handed, wherever it came from.
function fakePort() {
  const amounts = new Map();
  const settled = [];
  return {
    settled,
    async createHeld({ paymentHash, amountMsat }) { amounts.set(toHex(paymentHash), amountMsat); return { paymentHash, amountMsat, request: 'lnbc-dry' }; },
    async look({ paymentHash }) { const a = amounts.get(toHex(paymentHash)) || 0n; return { state: HELD, amountMsat: a, paidMsat: a, expiryHeight: 400 }; },
    async settle({ paymentHash, preimage }) { settled.push({ paymentHash: toHex(paymentHash), preimage: toHex(preimage) }); },
    async cancel() {},
  };
}

// ---- 1. THE LIGHTNING PORT, AND WHAT IT RAN -----------------------------------------------------
// Every lncli the port actually runs is recorded, because the settle's 32 bytes are an ARGUMENT to
// `settleinvoice` - so the bytes lnd was given are read off the invocation rather than taken on trust.
const calls = [];
const runA = (argv) => {
  calls.push(argv.slice());
  return new Promise((resolve, reject) => execFile(LNCLI, [...flags(A), ...argv],
    { timeout: 60000, maxBuffer: 8 << 20 },
    (err, stdout, stderr) => (err ? reject(new Error(`lncli ${argv[0]} refused: ${(stderr || err.message).trim()}`))
                                  : resolve(stdout))));
};
const lightning = DRY ? fakePort() : lndPort({ lncli: LNCLI, args: flags(A), expirySeconds: 3600, run: runA });

// THE ROUND'S RANDOMNESS IS A REAL TESTNET4 BLOCK. §12: the beacon has to come AFTER committee_time, or the
// close refuses to decide anything - "that randomness names no time, so nothing says it came after
// committee_time". lnd already knows the tip it is synced to, so the beacon is that block's hash, height and
// header time; the round's committee_time is set a minute before it, which is the order the spec wants.
const tip = DRY
  ? { block_hash: toHex(b32(0x9b)), block_height: 900001, best_header_timestamp: Math.floor(NOW / 1000) - 600 }
  : lnj(A, 'getinfo');
const BEACON = { hash: fromHex(tip.block_hash), height: Number(tip.block_height), timeMs: BigInt(tip.best_header_timestamp) * 1000n };
// COMMITTEE TIME IS BEFORE THE BEACON AND BEFORE NOW, WHICHEVER IS EARLIER. Measured live: testnet4's header
// timestamp ran 1.8 HOURS ahead of this machine's clock, so "the beacon's time minus a minute" put the
// committee in the future and the round was refused - "that round closes entry at ..., before its committee
// forms at ...". The only thing §12 needs is that the randomness came AFTER committee_time; anchoring the
// round's own timeline to the local clock keeps the entry window real while still satisfying that.
const local = BigInt(NOW) - 60000n;
const COMMITTEE_MS = BEACON.timeMs - 60000n < local ? BEACON.timeMs - 60000n : local;

const before = DRY ? { a: 0n, b: 0n } : { a: localMsat(A), b: localMsat(B) };
say(`\n=== ${DRY ? 'DRY (fake port, no sats)' : 'LIVE testnet4'} ===`);
if (!DRY) say(`channel before:  A local ${before.a} msat   B local ${before.b} msat`);

// ---- 2. TWO REAL SIGNER NODES ------------------------------------------------------------------
// A holds the Lightning port: it is the one that issues and settles. B has no port and does not need one -
// its whole job in §23.4 is to hold the other share and answer for it.
// AND THE PAYING-ROUND PREFLIGHT IS THE REAL ONE ON THE LIVE RUN. A node that holds stakes refuses to open a
// paying round until its Lightning is shown able to hold one, and `lndPreflight` reads the same two testnet4
// gateways this channel runs between (TESTNET4_GATEWAYS). Only the dry run stubs it, because there is no
// Lightning in a dry run to ask.
const preflight = DRY
  ? async () => ({ ready: true, why: 'dry run: the port is a fake, so there is no Lightning to preflight' })
  : lndPreflight({ lncli: LNCLI, lnddir: A.lnddir });
const serveOpts = { funded: () => true, preflight, randomnessFor: () => BEACON, finality: { everyMs: 250 } };
const a = await serve(openStore(':memory:'), { port: 0, lightning, ...serveOpts });
const b = await serve(openStore(':memory:'), { port: 0, ...serveOpts });
const at = (d) => `http://127.0.0.1:${d.port}`;
for (const [d, o] of [[a, b], [b, a]]) {
  const there = [at(o)];
  d.verifier.peers = there; d.payouts.peers = there; d.preimages.peers = there; d.dkg.peers = there;
}

// EVERY ASK FOR A SHARE IS COUNTED. `preimages.fetch` is the door out to the other seat; wrapping it is how
// this tool can say "P was built from N shares" with a number instead of a belief.
let shareAsks = 0;
const asked = [];
const fetchOfA = a.preimages.fetch.bind(a.preimages);
a.preimages.fetch = (u, o) => {
  if (String(u).includes('/share')) { shareAsks++; asked.push(String(u).split('?')[0]); }
  return fetchOfA(u, o);
};

const contract = {
  // §15's start deadline, named rather than defaulted: the aiming driver below arrives around tick 1018 and
  // plants its one first mark at the end of the run, which the omitted default of 900 would call a late start.
  startDeadlineTicks: 1400,
  networkId: NETWORK_ID_TESTNET4, configHash: TRUCK_CONFIG_HASH, censusConfirmations: 6,
  gameVerifySlots: 2, settlementSlots: 2, simCoreHash: CORE_HASH,
  committeeTimeMs: COMMITTEE_MS, randomnessRule: 'bitcoin-block-hash',
  // THE ROUND HAS ALREADY STARTED. Entry opens at committee_time and the start is the protocol's minimum
  // window after it, which the beacon's own age puts in the past - so there is a run to judge. Entry stays
  // open a little past now, because the entries are joined a moment from here.
  startTimeMs: COMMITTEE_MS + MIN_ENTRY_WINDOW_MS,
  entryCloseMs: BigInt(NOW) + 30000n,
  objectionWindowMs: 1n, custody: 'THRESHOLD_LN', slashMinimumServed: 20,
  slashRemainder: 'BURN', federationId: new Uint8Array(32), stakeExpiryBlocks: 144,
  publicationRelays: [at(a), at(b)],
  donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
  censusRoot: b32(2), stakeMsat: STAKE_MSAT, bondMinSats: 50000n, blockTicks: BLOCK_TICKS,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  // THE SEATS ARE THE NODES' OWN KEYS. The old tool named b32(8) and b32(9), which no process held, so no
  // share could ever have come back from one.
  nodes: [a.round.pubkey, b.round.pubkey],
};
const rid = roundIdOf(contract);
const needed = receiptsNeeded(contract.settlementSlots);
say(`round ${toHex(rid).slice(0, 16)}  seats ${contract.nodes.map((k) => toHex(k).slice(0, 10)).join(' + ')}`);
say(`threshold: ${needed} of ${contract.settlementSlots} (receiptsNeeded knows 2 and 7 only - this is NOT five of seven)`);

for (const d of [a, b]) {
  const r = await fetch(`${at(d)}/round`, { method: 'POST', body: encodeRoundContract(contract) });
  if (r.status !== 201) throw new Error(`round refused at ${at(d)}: ${await r.text()}`);
  d.round.recordSignerNodes(rid, contract.nodes);       // assumed out loud: no live testnet4 census here
}

// ---- 3. TWO ENTRIES, EACH PREIMAGE DEALT AS SHARES ---------------------------------------------
// A WALK-AWAY NEEDS SOMEBODY TO PAY. A round whose only entry is FORFEIT was refused outright, and the
// refusal is the money law talking: "no stake moves: the operator would keep 980000 msat: a pool of 980000
// against 0 handed out. every hold stays in flight and expires to its player." So the round has the shape
// the hold suites use - a qualifier beside the walk-away. The qualifier's own hold is CANCELLED back to it;
// the walk-away's is the one that must SETTLE, and its preimage is the one that has to be rebuilt.
const chosen = pickADeliveringWorld(b32(1));
say(`qualifier's world: secret 0x${toHex(chosen.worldSecret).slice(-2)}, lead ${chosen.knobs.lead} gain ${chosen.knobs.gain}`
  + ` -> DELIVERED at tick ${chosen.at}, score ${chosen.score}`);
const players = [
  { n: 1, name: 'qualifier', outcome: DELIVERED, score: chosen.score, world: chosen.worldSecret },
  { n: 2, name: 'walk-away', outcome: FORFEIT, score: 0, world: b32(0x5e) },
];
for (const p of players) {
  p.preimage = secretScalar();
  p.player = b32(p.n);
  p.session = ed25519.utils.randomSecretKey();
  const e = rand(32);
  p.dealt = await dealHandout({ preimage: p.preimage, signerNodes: contract.nodes, roundId: rid, playerPubkey: p.player,
    ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e),
    coefficients: [scalarFrom32(rand(32)) % FIELD], needed, curve: feldmanGroup });
  if (!p.dealt.ok) throw new Error(`${p.name}: the handout was not dealt: ${p.dealt.why}`);
  p.entry = {
    roundId: rid, playerPubkey: p.player, sessionPubkey: ed25519.getPublicKey(p.session),
    stakeCommitment: sha256(p.preimage),
    stakeMsat: STAKE_MSAT, feeMsat: entryFeeMsat(STAKE_MSAT), donationMsat: 0n, joinTick: 0,
    worldSecret: p.world, vssSharesRef: handoutId(p.dealt.handout), stakePoint: p.dealt.handout.commitments[0],
    feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n },
    feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
  };
  p.eid = entryIdOf(p.entry);
  for (const d of [a, b]) {
    const h = await fetch(`${at(d)}/handout`, { method: 'POST', body: encodeHandout(p.dealt.handout) });
    if (h.status !== 201) throw new Error(`${p.name}: handout refused at ${at(d)}: ${await h.text()}`);
    const j2 = await fetch(`${at(d)}/entry`, { method: 'POST', body: encodeEntryContract(p.entry) });
    if (j2.status !== 201) throw new Error(`${p.name}: entry refused at ${at(d)}: ${await j2.text()}`);
  }
  say(`${p.name}  entry ${toHex(p.eid).slice(0, 16)}  shares ${p.dealt.handout.shares.length} dealt at ${needed} of ${contract.nodes.length}`);
}
say(`stake ${STAKE_MSAT} msat each; each hold is the net ${netStakeMsat(players[0].entry)} msat (22A's 2% off)`);

// ---- 4. THE HOLDS, AND REAL PAYMENTS INTO THEM --------------------------------------------------
for (const p of players) {
  const quoted = await fetch(`${at(a)}/invoice?entry=${toHex(p.eid)}`);
  if (quoted.status !== 200) throw new Error(`${p.name}: A made no hold invoice: ${await quoted.text()}`);
  p.request = (await quoted.json()).request;
  say(`${p.name}  A holds ${String(p.request).slice(0, 24)}...`);
}
if (!DRY) for (const p of players)
  execFile(LNCLI, [...flags(B), 'payinvoice', '--force', '--timeout', '600s', p.request], { maxBuffer: 8 << 20 }, () => {});
for (const p of players) {
  await until(`${p.name}'s payment to arrive at A`, async () => {
    const l = await lightning.look({ paymentHash: p.entry.stakeCommitment });
    return l.paidMsat > 0n ? l : null;
  }, DRY ? 30000 : 300000);
  // AND B IS TOLD THE STAKE WAS PAID, the second assumption this tool makes out loud. The hold is an invoice
  // on A's Lightning node; B is the other SEAT and has no way to look inside it. Who watches the HTLC for the
  // other seats is a real question and not this letter's - this letter is about where the 32 bytes come from.
  // `putStakeSeen` writes the same row `Custody.seenPaid` writes on A once Lightning showed the full amount.
  b.round.putStakeSeen({ entryId: p.eid, paidMsat: netStakeMsat(p.entry) });
}
const inFlight = DRY ? before : { a: localMsat(A), b: localMsat(B) };
if (!DRY) say(`in flight:       A local ${inFlight.a} msat   B local ${inFlight.b} msat   (B down ${before.b - inFlight.b})`);

// ---- 4b. THE QUALIFIER ACTUALLY PLAYS -----------------------------------------------------------
// WITHOUT A RUN THERE IS NOTHING TO REPLAY, AND A SEAT THAT HAS REPLAYED NOTHING KEEPS ITS SHARE. Measured on
// the way here: with both entries silent, B answered the share door with "this node has replayed nothing for
// that run" and A stopped at "1 of 2 shares: a stake nobody can open stays in flight". So the qualifier
// drives, both seats replay the same words, and the walk-away stays silent - which is what makes it one.
const said = (d, message) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${d.port}/play`);
  ws.addEventListener('open', () => ws.send(message));
  ws.addEventListener('message', (ev) => { resolve(ev.data instanceof Blob ? ev.data : String(ev.data)); ws.close(); });
  ws.addEventListener('error', () => reject(new Error(`could not reach ${at(d)}/play`)));
});
const qualifier = players.find((p) => p.outcome === DELIVERED);
{
  const driven = driveAt(qualifier.entry, chosen.knobs, 1399);
  const tape = driven.tape;
  const input = { roundId: rid, entryId: qualifier.eid, previousHash: GENESIS, firstTick: 0, ticks: tape, liquidations: [] };
  const st = init(seedWordForEntry(qualifier.entry, BEACON.hash));
  for (const w of tape) step(st, ...w);
  const outcome = CORE.result(st);
  if (outcome.outcome !== 'DELIVERED') throw new Error(`the qualifier did not deliver: ${outcome.outcome} at ${tape.length}`);
  const mark = { roundId: rid, entryId: qualifier.eid, tick: tape.length,
    stateHash: Uint8Array.from(stateHashOf(st).match(/../g).map((x) => parseInt(x, 16))),
    inputChainHash: batchId(input), previousHash: NO_PREVIOUS, sessionPubkey: ed25519.getPublicKey(qualifier.session) };
  const signedMark = joinSigned(encodeCheckpoint(mark), ed25519.sign(checkpointId(mark), qualifier.session));
  say(`\nqualifier drives ${tape.length} ticks -> ${outcome.outcome}, score ${outcome.score}`);
  for (const d of [a, b]) {
    const back = await said(d, encodeInputBatch(input));
    const got = await said(d, signedMark);
    say(`  ${at(d)}  batch ${String(back).slice(0, 12)}  mark ${(got && got.size) || String(got).length} bytes back`);
  }
}

// ---- 5. THE CORE'S WORD, AND A SETTLE BUILT FROM SHARES ----------------------------------------
// NOTHING ABOUT THE VERDICT IS ASSERTED HERE. An earlier draft of this file drove the settle directly with
// `settleHeldInvoices({ finalFor: () => true })` - "treat this round as final" - and this paragraph used to
// say so. It is gone, and saying it still would understate the evidence: the round below is CLOSED at both
// seats and each reaches its own verdict. The preimage was never asserted either - with no injection left,
// custody's `preimageFor` is `fromTheCommittee` (server.js:309): A opens its own share, asks B over
// `GET /share`, and reconstructs P. If B does not answer there is no preimage, and the hold stays in flight
// until it expires back to its player.
// A SEAT WILL NOT HAND OVER ITS SHARE FOR A RUN IT HAS NOT JUDGED, and that is the design working. Asserting
// finality to A does not move B: asked for its share early, B answered "this node has replayed nothing for
// that run" and A stopped at "1 of 2 shares: a stake nobody can open stays in flight". So the round is closed
// for real at both seats, each reaches its own verdict - no first mark was ever planted, which is §15's
// walk-away, FORFEIT - and only then can P be rebuilt.
const close = (d) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${d.port}/play`);
  // node's own WebSocket is the browser one: addEventListener, not .on
  ws.addEventListener('open', () => ws.send(`close ${toHex(rid)}`));
  ws.addEventListener('message', (ev) => { resolve(String(ev.data)); ws.close(); });
  ws.addEventListener('error', () => reject(new Error(`could not reach ${at(d)}/play to close the round`)));
});
const waitFor = Number(BigInt(contract.entryCloseMs) - BigInt(Date.now())) + 1000;
if (waitFor > 0) { say(`\nwaiting ${Math.ceil(waitFor / 1000)}s for entry to close, then closing the round`); await wait(waitFor); }
say(`closing at both seats: ${(await Promise.all([close(a), close(b)])).join(' / ')}`);

const forfeited = players.find((p) => p.outcome === FORFEIT);
const settledNow = () => (DRY
  ? lightning.settled.map((s) => s.preimage)
  // `lnd-port` runs `settleinvoice --preimage <hex>`, so the bytes are the LAST argument, not the first
  // after the verb. Reading c[1] got the flag itself and called a perfectly good settle a failure.
  : calls.filter((c) => c[0] === 'settleinvoice').map((c) => c[c.length - 1]));
const usedHex = await until('A to settle the walk-away hold on a rebuilt preimage', async () => {
  const s = settledNow();
  return s.length ? s[0] : null;
}, DRY ? 30000 : 120000);

// ---- 6. WHAT MOVED, AND WHAT BUILT THE KEY ------------------------------------------------------
const after = DRY ? inFlight : { a: localMsat(A), b: localMsat(B) };
const pending = DRY ? 0 : (lnj(A, 'listchannels').channels || []).reduce((t, c) => t + (c.pending_htlcs || []).length, 0);
const rebuiltMatches = usedHex === toHex(forfeited.preimage);
const hashMatches = toHex(sha256(Uint8Array.from(usedHex.match(/../g).map((x) => parseInt(x, 16))))) === toHex(forfeited.entry.stakeCommitment);

say('\n================ a sat on a rebuilt key');
say(`  shares asked of the peer   ${shareAsks}   (${asked.join(', ') || 'none'})`);
say(`  shares that formed P       ${needed}  = this node's own + ${needed - 1} from the other seat`);
say(`  settle preimage            ${usedHex.slice(0, 32)}...`);
say(`  equals the dealt secret    ${rebuiltMatches}`);
say(`  hashes to the stake commit ${hashMatches}`);
if (!DRY) {
  say(`  channel A  before ${before.a} -> after ${after.a} msat   (moved ${after.a - before.a})`);
  say(`  channel B  before ${before.b} -> after ${after.b} msat   (moved ${after.b - before.b})`);
  say(`  pending HTLCs on A         ${pending}  (0 means the hold did not sit and expire back)`);
  say(`  lncli settleinvoice runs   ${calls.filter((c) => c[0] === 'settleinvoice').length}`);
}
say(`  two of two, NOT five of seven: receiptsNeeded(${contract.settlementSlots}) = ${needed}`);

await a.close();
await b.close();
if (!rebuiltMatches || !hashMatches) { say('\nFAILED: the settle did not use the reconstructed preimage'); process.exit(1); }
say('\nOK');
process.exit(0);
