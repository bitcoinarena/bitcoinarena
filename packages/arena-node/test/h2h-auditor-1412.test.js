// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1412 (§13A.1, RULED #1400): the head-to-head auditor service. A drawn node checks the round's moves itself and posts an H2H_AUDIT; the seat's
// desk (h2h-audit-desk.js, the door POST /h2h-audit keeps) takes it in time - one audit: the long window; two drawn auditors: the 60 s window. An
// undrawn node posts nothing; committee results the moves do not give get no audit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { createH2hAuditDesk } from '../src/h2h-audit-desk.js';
import { H2hAuditor } from '../src/h2h-auditor.js';
import { makeVrf, SUITE_SECP256K1_TAI } from '../../arena-protocol/src/vrf.js';
import { auditAlpha, vrfSecretFor, auditEligible } from '../../arena-protocol/src/auditor.js';
import { isH2hAuditor, h2hCheck } from '../../arena-protocol/src/h2h-audit.js';
import { headToHeadCommit, VERDICT } from '../../arena-protocol/src/head-to-head.js';
import { taggedHash, toHex } from '../../arena-protocol/src/hash.js';
import { lockSettlement } from '../../arena-protocol/src/lock-settlement.js';
import { DELIVERED, FAILED } from '../../arena-protocol/src/payout.js';
import { AUDITOR_VERSION } from '../../arena-protocol/src/constants.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const { secp256k1, schnorr } = await import('@noble/curves/secp256k1.js');
const vrf = makeVrf({ Point: secp256k1.Point, suite: SUITE_SECP256K1_TAI });
const verify = (sig, msg, pk) => { try { return schnorr.verify(sig, msg, pk); } catch { return false; } };
const node = (i) => { const secret = taggedHash('test/h2h-auditor-node', Uint8Array.of(i >> 8, i & 255)); return { secret, pubkey: schnorr.getPublicKey(secret) }; };
const N = 40, BOND_MIN = 50_000n;
const set = auditEligible({ entries: Array.from({ length: N }, (_, i) => ({ pubkey: node(i).pubkey, roles: ['audit'], bondSats: BOND_MIN, operatorId: `op${i}` })), bondMinSats: BOND_MIN });
const drawn = (rid, nd) => { const pi = vrf.prove(vrfSecretFor(nd.secret, secp256k1.Point), auditAlpha(rid)); return isH2hAuditor({ beta: vrf.proofToHash(pi), weight: set.eligible.get(toHex(nd.pubkey)), total: set.total }); };
let RID = null, AUD = [];
for (let i = 0; i < 80 && AUD.length < 2; i++) { RID = taggedHash('test/h2h-auditor-round', Uint8Array.of(i)); AUD = Array.from({ length: N }, (_, k) => node(k)).filter((nd) => drawn(RID, nd)); }
const UNDRAWN = Array.from({ length: N }, (_, k) => node(k)).find((nd) => !drawn(RID, nd));
// Rock Paper Scissors over two entries: paper (1) against rock (0)
const decide = (moves) => { const [a, b] = moves; const w = (a.move - b.move + 3) % 3;
  return w === 0 ? { [a.key]: VERDICT.DRAW, [b.key]: VERDICT.DRAW } : w === 1 ? { [a.key]: VERDICT.WIN, [b.key]: VERDICT.LOSS } : { [a.key]: VERDICT.LOSS, [b.key]: VERDICT.WIN }; };
const CLOSE = 1_000_000n, WIN = 10_000n, P = 1_015_000;
const entry = (n, move) => { const entryKey = taggedHash('test/key', Uint8Array.of(n)), salt = taggedHash('test/salt', Uint8Array.of(n));
  return { entryId: taggedHash('test/entry', Uint8Array.of(n)), entryKey, commit: headToHeadCommit({ roundId: RID, entryKey, move, salt }), reveal: { move, salt, atMs: CLOSE + 400n } }; };
const CHECK = { roundId: RID, decide, config: null, moveCount: 3, players: 2, entryCloseMs: CLOSE, revealWindowMs: WIN, entries: [entry(1, 1), entry(2, 0)] };
const AGREED = h2hCheck(CHECK).resultsHash;

const auditorFor = (nd, { clock, desk, agreedHash = AGREED }) => new H2hAuditor({
  selfKey: nd.pubkey, prove: (alpha) => vrf.prove(vrfSecretFor(nd.secret, secp256k1.Point), alpha), outputOf: (pi) => vrf.proofToHash(pi),
  sign: (d) => schnorr.sign(d, nd.secret), due: () => [{ roundId: RID, closeMs: P + 60_000 }], eligibleFor: () => set,
  dataFor: async () => ({ check: CHECK, agreedHash }),
  // the seat door: POST /h2h-audit hands the body to the desk (server.js), 201 when kept
  post: async (bytes, signature) => { const body = new Uint8Array(bytes.length + 64); body.set(bytes); body.set(signature, bytes.length); const r = await desk.take(body); return r.ok ? 1 : 0; },
  now: () => clock.now });

test('#1412 the auditor service: a drawn node checks the moves and its H2H_AUDIT is taken in time - one keeps 600 s, two make the 60 s window', async () => {
  const clock = { now: P + 8_000 };
  const desk = createH2hAuditDesk({ db: openStore(':memory:'), now: () => clock.now, vrf, verify,
    contextFor: async () => ({ ok: true, eligible: set.eligible, total: set.total, resultsHash: AGREED, provisionalAtMs: P }) });
  const facts = {};
  facts.undrawn = await auditorFor(UNDRAWN, { clock, desk }).pass();
  facts.differs = (await auditorFor(AUD[0], { clock, desk, agreedHash: taggedHash('test/other', Uint8Array.of(9)) }).pass())[0];
  const first = await auditorFor(AUD[0], { clock, desk }).pass();
  facts.first = first[0];
  facts.afterOne = (await desk.windowOf(RID)).window;
  clock.now = P + 20_000;
  facts.second = (await auditorFor(AUD[1], { clock, desk }).pass())[0];
  clock.now = P + 60_000;
  const w = await desk.windowOf(RID);
  facts.window = [w.window, w.final];
  console.log(`  MEASURED #1412 auditor: undrawn ${JSON.stringify(facts.undrawn)}; committee results the moves do not give -> ${JSON.stringify(facts.differs)}; drawn A -> ${JSON.stringify(facts.first)}, window ${facts.afterOne}; drawn B -> ${JSON.stringify(facts.second)}; at +60 s: ${facts.window.join(' ')}`);
  assert.deepEqual(facts.undrawn, []);
  assert.equal(facts.differs.differs, true);
  assert.equal(facts.first.seats, 1);
  assert.equal(facts.afterOne, 'long');
  assert.equal(facts.second.seats, 1);
  assert.deepEqual(facts.window, ['short', true]);
});

// THE 10 % PAY (step 6): the server hands settlement the auditors the H2H desk holds for a head-to-head round on the short window (server.js
// `auditors: [...auditDesk.held(rid), ...h2hDesk.held(rid) keys]`); lock-settlement.js pays them 10 % of the nodes' part, equally
test('#1412 the H2H auditors the desk holds are paid 10 % of the nodes\' part, equally - the players\' lines untouched', async () => {
  const clock = { now: P + 8_000 };
  const desk = createH2hAuditDesk({ db: openStore(':memory:'), now: () => clock.now, vrf, verify,
    contextFor: async () => ({ ok: true, eligible: set.eligible, total: set.total, resultsHash: AGREED, provisionalAtMs: P }) });
  for (const nd of AUD.slice(0, 2)) await auditorFor(nd, { clock, desk }).pass();
  const auditors = desk.held(RID).map((x) => toHex(x.nodePubkey));   // what server.js hands settlement
  const b = (n) => new Uint8Array(32).fill(n);
  const pk = (n) => { const k = new Uint8Array(32); k[0] = n; k[31] = n; return k; };
  const refund = (n) => { const k = new Uint8Array(33); k[0] = 0x02; k[1] = n; k[32] = n; return k; };
  const STAKE = 10_000_000n, FEE = (STAKE * 4n) / 100n, nodes = [pk(0xa1), pk(0xa2)];
  const e = (n, outcome, score) => ({ pubkey: pk(n), stakeMsat: STAKE, feeMsat: FEE, donationMsat: 0n, outcome, score });
  const W = e(1, DELIVERED, 2), L = e(2, FAILED, 0);
  const locks = new Map([W, L].map((x, i) => [toHex(x.pubkey), { outpoint: { txid: b(0x40 + i), outIdx: BigInt(i) }, amountMsat: STAKE - FEE, refundPk: refund(i + 1) }]));
  const feeLocks = new Map([W, L].map((x, i) => [toHex(x.pubkey), { outpoint: { txid: b(0x80 + i), outIdx: BigInt(i) }, amountMsat: FEE, preimage: b(0xf0 + i) }]));
  const contract = { networkId: b(0x4e), configHash: b(0x43), censusConfirmations: 1, gameVerifySlots: 2, settlementSlots: 2, gameId: NEXTBLOCK_GAME_ID, simCoreHash: b(1),
    startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 60000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID,
    stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: b(0xd0), censusHeight: 900000, censusRoot: b(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash',
    stakeMsat: STAKE, bondMinSats: 50000n, blockTicks: 9000, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1,
    rankNumerator: 3, rankDenominator: 4, nodes, protocolVersion: AUDITOR_VERSION };
  const plan = (aud) => lockSettlement({ roundId: b(0x5f), entries: [W, L], minScore: 1, locks, feeLocks, fees: { ppm: 0n, baseMsat: 1000n }, contract,
    signerNodes: { gameVerify: nodes, settlement: nodes, ...(aud ? { auditors: aud } : {}) } });
  const none = plan(null), paid = plan(auditors);
  const lines = paid.payouts.filter((x) => x.kind === 'auditor');
  const nodesPart = none.payouts.filter((x) => x.kind === 'signer node').reduce((t, x) => t + x.msat + x.feeMsat, 0n);
  const playerLines = (p) => p.payouts.filter((x) => x.kind !== 'auditor' && x.kind !== 'signer node' && x.kind !== 'reserve').map((x) => `${x.kind}:${x.msat}`).join(',');
  console.log(`  MEASURED #1412 pay: ${auditors.length} H2H auditors held -> ${lines.length} lines of ${lines.map((x) => x.owedMsat).join(' / ')} msat of a nodes' part of ${nodesPart} msat; players' lines the same: ${playerLines(none) === playerLines(paid)}`);
  assert.equal(none.ok && paid.ok, true);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].owedMsat, lines[1].owedMsat);
  assert.ok(lines[0].owedMsat * 20n >= nodesPart - 4000n && lines[0].owedMsat * 20n <= nodesPart + 4000n, `each about 5 %: ${lines[0].owedMsat} of ${nodesPart}`);
  assert.equal(playerLines(none), playerLines(paid));
});
