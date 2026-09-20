// THE HOLD-INVOICE STATE MACHINE AGAINST THE LIVE TESTNET4 PAIR (M3, the owner 2026-09-20).
//
// `custody-lnd.mjs` proves the same rules on an isolated regtest it spawns and MINES. This runs the same
// `Custody` - the same four operations, the same outcome mapping - against the two gateways that actually
// exist, and mines nothing, because nobody can mine testnet4.
//
//   A  /mnt/bitcoin/lnd-testnet4    0274e261...  rpc 11009   the custodian: it issues the hold
//   B  /mnt/bitcoin/lnd-testnet4-b  025f17c2...  rpc 11010   the player's wallet: it pays
//
// THE OUTCOME WORD COMES FROM THE CORE, never from this script and never from a browser. Each entry is handed
// to `custody.settleHeldInvoices` with the round's verdict, and `custody.js` decides what that word means:
//
//   DELIVERED  -> cancel   -> CANCELLED   the player delivered; the stake goes back
//   FORFEIT    -> settle   -> SETTLED     the preimage is released; the stake enters the pool
//   VOID       -> NOTHING  -> EXPIRED     no port call of any kind
//
// VOID IS AN ABSENCE AND THAT IS THE POINT. "A cancel is an ACT, and it needs five of seven; a refund that
// needed an act is one an operator could withhold." What refunds a void player is Bitcoin's timelock, not our
// goodwill - measured on regtest: an invoice expiry stops applying the moment an HTLC is ACCEPTED, and the
// HTLC failed back at height 332 of an expiry at 345. On testnet4 that wait is real hours, so this tool
// proves the absence and RECORDS the expiry height against the tip; the refund itself is a later pass.
//
// AND THEN IT CLEANS UP, WHICH IS NOT THE PROTOCOL PATH AND SAYS SO. A paid hold left sitting until its CLTV
// is a hold lnd will eventually force-close the channel to resolve - and that channel is the inbound the
// gateways were just proved to have. So after the VOID measurement is taken, the third hold is cancelled as
// HOUSEKEEPING, clearly labelled, after the numbers are in. Nothing about the VOID row is read from it.
//
// STILL SINGLE-NODE CUSTODY, NOT §23.5. One endpoint issues and settles; `preimageFor` is handed in rather
// than reconstructed from five of seven shares. FROST closes that gap. This does not, and does not pretend to.
//
//   node packages/blwp-node/tools/custody-testnet4.mjs [--stake-msat 1000000]
import { TRUCK_CONFIG_HASH } from '../src/cores.js';
import { CORE_HASH } from './core-hash.mjs';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../protocol/src/donation.js';
import { execFile, execFileSync } from 'node:child_process';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { Custody, HELD, SETTLED, CANCELLED } from '../src/custody.js';
import { lndPort } from '../src/lnd-port.js';
import { DELIVERED, FORFEIT, VOID } from '../../protocol/src/payout.js';
import { entryId as entryIdOf } from '../../protocol/src/contracts.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';
import { MIN_ENTRY_WINDOW_MS } from '../../protocol/src/constants.js';
import { NETWORK_ID_TESTNET4 } from '../../protocol/src/genesis-ids.js';
import { BLOCK_TICKS } from '../../core/src/rules/gate.js';
import { toHex, sha256 } from '../../protocol/src/hash.js';

const LNCLI = process.env.BLWP_LNCLI || '/mnt/bitcoin/lnd-linux-amd64-v0.21.3-beta/lncli';
const A = { lnddir: '/mnt/bitcoin/lnd-testnet4', rpc: '127.0.0.1:11009', name: 'A lnd-testnet4' };
const B = { lnddir: '/mnt/bitcoin/lnd-testnet4-b', rpc: '127.0.0.1:11010', name: 'B lnd-testnet4-b' };
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const STAKE_MSAT = BigInt(arg('stake-msat', '1000000'));          // 1000 sat, three of them, on a 200k sat channel
const NOW = Date.now();
const say = (s) => console.log(s);
const b32 = (n) => { const b = new Uint8Array(32); b[31] = n; return b; };
// EVERY RUN GETS ITS OWN PREIMAGES, so its hashes are its own. Fixed constants collide with the invoices an
// earlier run left on the endpoint - measured: a re-run died on "this endpoint already had an invoice for
// that hash and it is CANCELED, not a hold still in flight", which is the port refusing to take up a hold
// that is no longer one. The run's nonce goes in the middle; the player's number stays in the last byte.
const RUN = BigInt(Date.now());
const preimageOf = (n) => {
  const b = new Uint8Array(32);
  b[0] = 0xc0;
  for (let i = 0; i < 6; i++) b[1 + i] = Number((RUN >> BigInt(8 * i)) & 0xffn);
  b[31] = n;
  return b;
};

const flags = (n) => [`--lnddir=${n.lnddir}`, `--rpcserver=${n.rpc}`, '--network=testnet4'];
const ln = (n, ...argv) => execFileSync(LNCLI, [...flags(n), ...argv], { encoding: 'utf8', timeout: 60000, maxBuffer: 8 << 20 });
const lnj = (n, ...argv) => JSON.parse(ln(n, ...argv));
const localMsat = (n) => BigInt((lnj(n, 'listchannels').channels[0] || {}).local_balance || 0) * 1000n;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, ok, tries = 60) {
  for (let i = 0; i < tries; i++) { const v = await ok(); if (v) return v; await sleep(1000); }
  throw new Error(`gave up waiting for ${what}`);
}

// ---- 1. THE PAIR, AS IT STANDS ------------------------------------------------------------------
for (const n of [A, B]) {
  const info = lnj(n, 'getinfo');
  if (info.synced_to_chain !== true) throw new Error(`${n.name} is not synced to its chain`);
  say(`${n.name}  ${info.identity_pubkey.slice(0, 8)}...  block ${info.block_height}  channels ${info.num_active_channels}`);
}
const tipAtStart = lnj(A, 'getinfo').block_height;
const before = { a: localMsat(A), b: localMsat(B) };
say(`channel before: A local ${before.a} msat, B local ${before.b} msat\n`);

// ---- 2. A ROUND AND THREE ENTRIES ---------------------------------------------------------------
const round = new Round(openStore(':memory:'), () => NOW);
const contract = {
  networkId: NETWORK_ID_TESTNET4, configHash: TRUCK_CONFIG_HASH, censusConfirmations: 6,
  gameVerifySlots: 2, settlementSlots: 2, simCoreHash: CORE_HASH,
  committeeTimeMs: BigInt(NOW), randomnessRule: 'bitcoin-block-hash',
  startTimeMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS,
  entryCloseMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS + 200000n,
  objectionWindowMs: 600000n, custody: 'THRESHOLD_LN', slashMinimumServed: 20,
  slashRemainder: 'BURN', federationId: new Uint8Array(32), stakeExpiryBlocks: 144,
  // §13A: a round that takes a stake must name somewhere its results can be published, or none of them can
  // become final and no stake in it could ever settle. A local relay is enough to make the round legal here;
  // nothing in this tool publishes to it, and the settlement is driven by `finalFor` directly.
  publicationRelays: ['http://127.0.0.1:8191/relay'],
  donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
  censusRoot: b32(2), stakeMsat: STAKE_MSAT, bondMinSats: 50000n, blockTicks: BLOCK_TICKS,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [b32(8), b32(9)],
};
const rid = round.open(contract);

// EVERY lncli THE PORT ACTUALLY RUNS, recorded here rather than trusted. `lndPort` keeps no log of its own -
// the suite's fake port does - so the absence the VOID row rests on is measured from the real invocations.
const calls = [];
const runA = (argv) => {
  calls.push(argv.join(' '));
  return new Promise((resolve, reject) => execFile(LNCLI, [...flags(A), ...argv],
    { timeout: 60000, maxBuffer: 8 << 20 },
    (err, stdout, stderr) => (err ? reject(new Error(`lncli ${argv[0]} refused: ${(stderr || err.message).trim()}`))
                                  : resolve(stdout))));
};
const port = lndPort({ lncli: LNCLI, args: flags(A), expirySeconds: 3600, run: runA });
const custody = new Custody(round, { port, preimageFor: (id, e) => preimageOf(e.pubkey[31]) });

const players = [
  { n: 1, name: 'winner', outcome: DELIVERED, score: 9 },
  { n: 2, name: 'loser ', outcome: FORFEIT, score: 0 },
  { n: 3, name: 'voided', outcome: VOID, score: 0 },
];
for (const p of players) {
  p.entry = {
    roundId: rid, playerPubkey: b32(p.n), sessionPubkey: b32(p.n + 40),
    stakeCommitment: sha256(preimageOf(p.n)),
    stakeMsat: STAKE_MSAT, feeMsat: entryFeeMsat(STAKE_MSAT), donationMsat: 0n, joinTick: 0,
    worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33),
    feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n },
    feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
  };
  round.enter(p.entry);
  const held = await custody.hold(p.entry);
  if (!held.ok) throw new Error(`A could not hold ${p.name}'s stake: ${held.why}`);
  p.request = held.invoice;
  p.id = entryIdOf(p.entry);
  p.state0 = custody.stateOf(p.id).state;
  say(`  ${p.name}  hold for ${toHex(p.entry.stakeCommitment).slice(0, 16)}...  ${STAKE_MSAT} msat  -> ${p.state0}`);
}

// ---- 3. B PAYS. THE PAYMENTS STAY IN FLIGHT, WHICH IS THE POINT ---------------------------------
say('\nB pays all three; they stay in flight:');
for (const p of players)
  p.pay = new Promise((resolve) => execFile(LNCLI, [...flags(B), 'payinvoice', '--force', '--timeout', '600s', p.request],
    { maxBuffer: 8 << 20 }, (err, out) => resolve(((out || '') + (err ? err.message : '')))));
// THE HOLD IS FOR THE NET STAKE, NOT THE GROSS ONE, and waiting for the wrong number is how this first read
// as "the payments never arrived" when they were ACCEPTED all along: `custody.hold` asks for
// `netStakeMsat(entry)` - the stake less 22A's 2% - so a 1000000 msat stake is a 980000 msat invoice.
for (const p of players) {
  const got = await until(`${p.name}'s payment to arrive`,
    async () => { const l = await port.look({ paymentHash: p.entry.stakeCommitment }); return l.paidMsat > 0n ? l : null; });
  p.paidMsat = got.paidMsat;
}
const inFlight = { a: localMsat(A), b: localMsat(B) };
for (const p of players) {
  p.lnd = lnj(A, 'lookupinvoice', toHex(p.entry.stakeCommitment)).state;
  p.ours = custody.stateOf(p.id).state;
  say(`  ${p.name}  lnd says ${p.lnd}, this node says ${p.ours}, paid ${p.paidMsat} msat (stake ${STAKE_MSAT} less 22A's fee)`);
}
say(`  in flight: A local ${inFlight.a} msat, B local ${inFlight.b} msat (B down ${before.b - inFlight.b})`);

// the void HTLC's own expiry, recorded now against the tip - the refund itself is a later pass
const voided = players.find((p) => p.outcome === VOID);
const voidInvoice = lnj(A, 'lookupinvoice', toHex(voided.entry.stakeCommitment));
const voidExpiryHeight = Math.min(...(voidInvoice.htlcs || []).map((h) => Number(h.expiry_height || 0)).filter((h) => h > 0));

// ---- 4. THE CORE'S WORD, AND WHAT A DOES ABOUT IT -----------------------------------------------
const out = await custody.settleHeldInvoices({
  roundId: rid, minScore: 1, finalFor: () => true,
  // THE NET STAKE IS THE STAKE LESS THE FEE AND THE DONATION (22A). An entry that names only its stake is
  // refused here rather than settled for an amount nobody signed.
  entries: players.map((p) => ({ entryId: p.id, pubkey: p.entry.playerPubkey,
    outcome: p.outcome, score: p.score, stakeMsat: STAKE_MSAT,
    feeMsat: p.entry.feeMsat, donationMsat: p.entry.donationMsat })),
});
if (!out.ok) throw new Error(out.why);
say('\nthe round is final, and A acts on the core\'s word:');
for (const p of players) {
  const act = out.actions.find((a) => toHex(a.entryId) === toHex(p.id));
  p.action = act.action; p.state = act.state;
  say(`  ${p.name}  ${p.outcome.padEnd(10)} -> ${String(p.action).padEnd(8)} -> ${p.state}`);
}
for (const p of players)
  if (p.outcome !== VOID) await until(`${p.name}'s payment to resolve`, async () => !!(await p.pay));
const after = { a: localMsat(A), b: localMsat(B) };
say(`\nafter the acts: A local ${after.a} msat, B local ${after.b} msat`);
say(`  A moved ${after.a - inFlight.a} msat, B moved ${after.b - inFlight.b} msat`);

// ---- 5. WHAT THE VOID ROW PROVES, AS AN ABSENCE -------------------------------------------------
const log = calls;
const voidHash = toHex(voided.entry.stakeCommitment);
const touched = log.filter((l) => l.includes(voidHash) && /settleinvoice|cancelinvoice/.test(l));
say('\nVOID, proved as an absence:');
say(`  ${log.length} lncli calls were made; its hash appears in ${touched.length} settle/cancel`);
say(`  its hash in no settle and no cancel: ${touched.length === 0 ? 'YES' : 'NO - ' + touched.join(', ')}`);
say(`  lnd still says ${lnj(A, 'lookupinvoice', voidHash).state}`);
say(`  its HTLC expires at height ${voidExpiryHeight}, the chain is at ${lnj(A, 'getinfo').block_height}`
  + `  (${voidExpiryHeight - lnj(A, 'getinfo').block_height} blocks away - the refund is a later pass)`);

// ---- 6. HOUSEKEEPING, NOT THE PROTOCOL PATH -----------------------------------------------------
// The numbers above are taken. A paid hold left until its CLTV is one lnd force-closes the channel to
// resolve, and that channel is the gateways' only inbound. So it is cancelled HERE, after the measurement,
// as cleanup - and nothing in the VOID row above is read from this.
if (!process.argv.includes('--leave-void-held')) {
  await port.cancel({ paymentHash: voided.entry.stakeCommitment });
  await until('the void payment to fail back', async () => !!(await voided.pay));
  const end = { a: localMsat(A), b: localMsat(B) };
  say(`\nhousekeeping (NOT the VOID path): the third hold cancelled so the channel is not force-closed later.`);
  say(`  A local ${end.a} msat, B local ${end.b} msat`);
}
// ---- 7. THE TWO WAYS A SETTLE IS REFUSED, both BEFORE the port is called ------------------------
// Neither needs a payment: `custody.js` checks the preimage against the hold's own hash and never reaches
// lnd if it does not fit. So these are proved on unpaid holds - no HTLC, no liquidity held, nothing to
// force-close later - and the count of lncli calls is read either side to show the port stayed untouched.
say('\na settle is refused before lnd is asked, twice:');
let guardN = 20;
for (const [label, maker, expect] of [
  ['no preimage   ', () => null, /no preimage for that stake/],
  ['wrong preimage', () => preimageOf(200), /not the one this hold was made for/],
]) {
  guardN += 2;
  // A LONE FORFEIT IS REFUSED FOR A DIFFERENT AND CORRECT REASON - "the operator would keep 980000 msat: a
  // pool of 980000 against 0 handed out" - so the guard needs a winner beside it for the pool to reach. Both
  // are paid, both are given straight back below; only the FORFEIT one is the case under test.
  const mk = (n) => ({ ...players[0].entry, playerPubkey: b32(n), sessionPubkey: b32(n + 40),
    stakeCommitment: sha256(preimageOf(n)) });
  const guard = { entry: mk(guardN), id: null };
  const mate = { entry: mk(guardN + 1), id: null };
  const own = new Custody(round, { port, preimageFor: maker });
  const paid = [];
  for (const who of [mate, guard]) {
    round.enter(who.entry);
    const h = await own.hold(who.entry);
    if (!h.ok) throw new Error(`could not make the guard hold: ${h.why}`);
    who.id = entryIdOf(who.entry);
    who.pay = new Promise((resolve) => execFile(LNCLI, [...flags(B), 'payinvoice', '--force', '--timeout', '600s', h.invoice],
      { maxBuffer: 8 << 20 }, (err, out) => resolve(((out || '') + (err ? err.message : '')))));
    await until('a guard payment to arrive',
      async () => (await port.look({ paymentHash: who.entry.stakeCommitment })).paidMsat > 0n);
    paid.push(who);
  }
  const was = calls.length;
  const r = await own.settleHeldInvoices({
    roundId: rid, minScore: 1, finalFor: () => true,
    entries: [
      { entryId: mate.id, pubkey: mate.entry.playerPubkey, outcome: DELIVERED, score: 9,
        stakeMsat: STAKE_MSAT, feeMsat: mate.entry.feeMsat, donationMsat: mate.entry.donationMsat },
      { entryId: guard.id, pubkey: guard.entry.playerPubkey, outcome: FORFEIT, score: 0,
        stakeMsat: STAKE_MSAT, feeMsat: guard.entry.feeMsat, donationMsat: guard.entry.donationMsat },
    ],
  });
  if (!r.ok || !r.actions || !r.actions.length)
    throw new Error(`the guard settlement returned nothing to read: ok=${r.ok} why=${r.why}`);
  const act = r.actions.find((a) => toHex(a.entryId) === toHex(guard.id));
  const asked = calls.slice(was).filter((c) => /settleinvoice/.test(c)).length;
  say(`  ${label}  -> ${act.state}, ${asked} settleinvoice calls, "${(act.why || '').slice(0, 56)}..."`);
  if (act.state !== HELD || asked !== 0 || !expect.test(act.why || ''))
    throw new Error(`that refusal is not the one the rules name: ${act.state} / ${asked} / ${act.why}`);
  for (const who of paid) { try { await port.cancel({ paymentHash: who.entry.stakeCommitment }); } catch { /* already resolved */ } }
  for (const who of paid) await until('a guard payment to come back', async () => !!(await who.pay));
}

say(`\ntip at start ${tipAtStart}; stake ${STAKE_MSAT} msat each.`);
process.exit(0);
