// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A TEMPLATE-3 GUARDIAN BOND PAYS A LIQUIDATION'S NOTES (kanban #1093 part 2, ruling #1111). A slash with no round - a theft's or an abandonment's - is released by the census key to
// the same PayoutTable with round_id 32 zero bytes, no entries, and its outputs the filer and one census-key escrow output. That escrow is spent by the census key to carriers'
// peg-ins into a safe federation, for the claims the one ledger accepted and no other escrow pays, and each carrier pays its claims at face. Real keys, real BIP-341 sighashes, real
// hold and escrow outputs, a real FROST census key, and one small chain that takes a spend only when its inputs are there and their relative locks have run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { holdOutputKey, slashStartLeaf } from '../../arena-protocol/src/bond-script.js';
import { arbitrationCommitment } from '../../arena-protocol/src/arbitration-tx.js';
import { serializeSpend } from '../../arena-protocol/src/bond-spend.js';
import { decodeSlashPayoutTable, encodeSlashPayoutTable } from '../../arena-protocol/src/slash.js';
import { slashEscrowOutput } from '../../arena-protocol/src/slash-release.js';
import { claimsOwed, decodeLiquidationClaims, decodeLiquidationEscrowOutputs, encodeLiquidationEscrowOutputs, isRoundless, liquidationClaimsId, liquidationEscrowOutputsId,
  liquidationEscrowSpend, liquidationSlices, liquidationTxOf } from '../../arena-protocol/src/liquidation-escrow.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { CARRIER_PAYOUT_MARGIN_MSAT } from '../../arena-protocol/src/genesis.js';
import { taggedHash, toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { tweakPoint } from '../src/curve.js';
import { createCensusSigner } from '../src/census-sign.js';
import { censusKeyWork } from '../src/census-key-work.js';
import { createSlashRelease } from '../src/slash-release-run.js';

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const tag = (n) => taggedHash('ARENA/test/LiquidationRun', Uint8Array.of(n));
const toScalar = (b) => BigInt(`0x${toHex(b)}`) % N;
const THRESHOLD = 4;
const dealt = (() => {
  let a0 = toScalar(tag(1));
  if (secp256k1.getPublicKey(tag(1), true)[0] === 3) a0 = N - a0;
  const co = [a0, toScalar(tag(2)), toScalar(tag(3)), toScalar(tag(4))];
  return { publicKey: schnorr.getPublicKey(tag(1)), share: (x) => co.reduce((sum, c, i) => (sum + c * BigInt(x) ** BigInt(i)) % N, 0n) };
})();
const census = { key: dealt.publicKey, hex: toHex(dealt.publicKey) };
const person = (n) => { const secret = tag(100 + n); return { secret, key: schnorr.getPublicKey(secret), hex: toHex(schnorr.getPublicKey(secret)) }; };
const b32 = (n) => new Uint8Array(32).fill(n);
const display = (internal) => toHex([...internal].reverse());
const clocks = { holdBlocks: 1, returnBlocks: 12, fallbackBlocks: 24 };
const MARGIN = CARRIER_PAYOUT_MARGIN_MSAT.regtest;
const PAYOUT_FEE_MSAT = 352n;
const BOND = 1_000_000n, MATURITY = 600, START_HEIGHT = 400, SLASH_HEIGHT = 399;
const accused = person(40);
const holders = [[person(50), [1, 2]], [person(51), [3]], [person(52), [4]], [person(53), [5]]];
const proofBytes = Uint8Array.of(0x46, 7, 7);
const proofId = taggedHash('ARENA/v1/SlashProof', proofBytes);
const bond = { txid: b32(0x91), vout: 1 };
const feeCoin = { txid: b32(0x92), vout: 0, value: 700n, script: fromHex(`5120${'93'.repeat(32)}`) };
const fedL = '1e'.repeat(32), fedA = 'fa'.repeat(32), fedB = 'fb'.repeat(32);
const reserveKey = (fid) => Uint8Array.from([0x02, ...fromHex(fid)]);
const fed = (id, reserve) => ({ federation: id, status: 'OPEN', reserveKey: toHex(reserveKey(id)), reserveSats: String(reserve), exposureCapSats: '1000000' });
const RECORDS = [fed(fedL, 0), fed(fedA, 600000), fed(fedB, 100000)];         // B is the safest: lowest load; L is the liquidating one
const advert = { bondScriptTemplateVersion: 3, censusKey: census.key, ownerPubkey: accused.key, bondMaturityHeight: MATURITY };
const scriptOfAddress = (address) => fromHex(`5120${toHex(taggedHash('ARENA/test/Address', new TextEncoder().encode(address)))}`);
const hold = holdOutputKey({ ownerKey: accused.key, censusKey: census.key, panelA: [], panelB: [], bondMaturity: MATURITY, ...clocks }, { tweakPoint });
const escrowBare = slashEscrowOutput({ censusKey: census.key, fallbackBlocks: clocks.fallbackBlocks }, { tweakPoint });
const claim = (n, msat, height = 420) => ({ nonce: toHex(b32(0xc0 + n)), amountMsat: String(msat), payoutPk: `02${toHex(b32(0xd0 + n))}`, height });

function startOf() {
  const tx = { version: 2, locktime: 0, inputs: [{ txid: bond.txid, vout: bond.vout, sequence: 0xfffffffd }, { txid: feeCoin.txid, vout: 0, sequence: 0xfffffffd }],
    outputs: [{ value: BOND, script: hold.script }, arbitrationCommitment(proofId, SLASH_HEIGHT, new TextEncoder().encode('arena'))] };
  const raw = serializeSpend({ ...tx, witnesses: [[new Uint8Array(64), new Uint8Array(65), slashStartLeaf(accused.key, census.key), new Uint8Array(65)], [new Uint8Array(64), new Uint8Array(34), new Uint8Array(33)]] });
  return { raw, txid: parseTransaction(raw).txid, hex: display(parseTransaction(raw).txid) };
}
const feeFunding = serializeSpend({ version: 2, locktime: 0, inputs: [{ txid: b32(9), vout: 0, sequence: 0 }], outputs: [{ value: 700n, script: feeCoin.script }], witnesses: [[new Uint8Array(64)]] });

function chain(tip) {
  const utxo = new Map(), mempool = [], raws = new Map();
  const c = {
    tip, mined: [], mempool, claims: new Map(),
    add(txidHex, vout, value, script, height) { utxo.set(`${txidHex}:${vout}`, { sats: value, script: toHex(script), height }); },
    txOut: async (txid, vout) => { const o = utxo.get(`${txid}:${vout}`); return o ? { sats: o.sats, script: o.script, confirmations: c.tip - o.height + 1 } : null; },
    rawTx: async (txid) => raws.get(txid) || null,
    send: async (hex) => {
      const tx = parseTransaction(fromHex(hex)), txid = display(tx.txid);
      if (mempool.some((m) => m.txid === txid) || utxo.has(`${txid}:1`)) throw new Error('txn-already-in-mempool');
      for (const i of tx.inputs) {
        const name = `${display(i.previousTxid)}:${i.previousVout}`, o = utxo.get(name);
        if (!o) throw new Error('bad-txns-inputs-missingorspent');
        if (mempool.some((m) => m.spends.includes(name))) throw new Error('txn-mempool-conflict');
        if (!(i.sequence & 0x80000000) && c.tip + 1 - o.height < (i.sequence & 0xffff)) throw new Error('non-BIP68-final');
      }
      mempool.push({ txid, tx, hex, spends: tx.inputs.map((i) => `${display(i.previousTxid)}:${i.previousVout}`) });
      return txid;
    },
    mine() {
      c.tip += 1;
      for (const m of mempool.splice(0)) {
        for (const s of m.spends) utxo.delete(s);
        m.tx.outputs.forEach((o, i) => { if (o.script[0] !== 0x6a) utxo.set(`${m.txid}:${i}`, { sats: o.value, script: toHex(o.script), height: c.tip }); });
        raws.set(m.txid, fromHex(m.hex));
        c.mined.push(m);
      }
    },
  };
  return c;
}

/** The holders' seats, each with its own store and run, on one chain; `ledger()` the one claims ledger of federation L as the claims door answers it. */
function world({ ledger, tip = START_HEIGHT + 1 }) {
  const start = startOf();
  const c = chain(tip);
  c.add(start.hex, 0, BOND, hold.script, START_HEIGHT);
  const urlOf = (k) => `http://seat-${k}`;
  const seats = new Map(), paid = [], logs = [];
  const answer = (body, status = 200) => ({ ok: status === 200, status, json: async () => body, text: async () => JSON.stringify(body) });
  const fetchFn = async (url, init = {}) => {
    const u = new URL(url), s = seats.get(u.host.slice(5));
    if (!s) return answer({ why: 'no such seat' }, 404);
    if (u.pathname === '/census-sign/commit') return answer(await s.signer.takeCommit(JSON.parse(init.body)));
    if (u.pathname === '/census-sign/share') return answer(await s.signer.takeShare(JSON.parse(init.body)));
    if (u.pathname === '/slash-release') return answer(s.run.served(u.searchParams.get('start')));
    const carriers = /^\/slash\/([0-9a-f]{64})\/carriers$/.exec(u.pathname);
    if (carriers && init.method === 'POST') { const t = await s.run.takeCarrierPegIn(carriers[1], JSON.parse(init.body)); return answer(t, t.ok ? 200 : t.status); }
    if (carriers) return answer(s.run.servedCarriers(carriers[1]));
    return answer({}, 404);
  };
  const live = { entries: [{ pubkey: accused.key, txid: bond.txid, vout: bond.vout, bondSats: String(BOND), script: fromHex(`5120${'94'.repeat(32)}`), hold: { txid: toHex(start.txid), vout: 0, height: START_HEIGHT }, advert },
    ...holders.map(([p], i) => ({ pubkey: p.key, txid: b32(10 + i), vout: 0, bondSats: String(BOND), advert }))] };
  const rawTx = async (txid) => (txid === start.hex ? start.raw : txid === display(feeCoin.txid) ? feeFunding : c.rawTx(txid));
  const holderList = holders.map(([p, xs]) => ({ key: p.hex, shares: xs.length }));
  const judge = Object.assign(async () => ({ verdict: true, why: 'a theft' }), { read: () => ({ ok: true, kind: 'theft', roundId: null, contract: null, federationId: fromHex(fedL), nodePubkey: accused.key }) });
  for (const [p, xs] of holders) {
    const shares = { shares: new Map(xs.map((x) => [x, dealt.share(x)])) };
    let made = 0;
    const clients = new Map();
    const portOf = (fid) => {
      if (!clients.has(fid)) {
        let held = 0n;
        clients.set(fid, { peginAddress: async () => `addr-${p.hex}-${fid}-${made++}`, peginClaim: async (address) => { const m = c.claims.get(address) ?? 0n; held += m; return { claimedMsat: m }; },
          ecashBalance: async () => held,
          payouts: async (list) => {
            const out = list.reduce((a, x) => a + x.msat, 0n);
            if (out + PAYOUT_FEE_MSAT > held) throw new Error(`the client holds ${held} msat, not ${out} and the fee`);
            held -= out + PAYOUT_FEE_MSAT;
            paid.push({ carrier: p.hex, federation: fid, list });
            return { txid: 'cc'.repeat(32), payouts: list.map((x, i) => ({ refundPk: x.key, outIdx: i })) };
          } });
      }
      return clients.get(fid);
    };
    const s = {};
    s.run = createSlashRelease({ key: p.key, secret: p.secret, networkId: NETWORK_ID_REGTEST, clocks, db: new DatabaseSync(':memory:'), tweakPoint,
      tipHeight: async () => c.tip, entriesAtTip: async () => live.entries, rawTx, unspent: async (t, v) => !!(await c.txOut(t, v)), txOut: c.txOut,
      fetchProof: async () => proofBytes, judge, panelsOf: () => ({ ok: false }), seatsOf: async () => [], lossesFor: async () => ({ ok: false, why: 'no round' }),
      federations: async () => RECORDS, federationsAt: async () => RECORDS, portFor: async (fid) => portOf(fid), scriptOf: scriptOfAddress, reserveKeyOf: async (fid) => reserveKey(fid), urlOf,
      heldKey: (k) => (toHex(k) === census.hex ? shares : null), thresholdOf: (k) => (k === census.hex ? THRESHOLD : null), holdersOf: async (k) => (k === census.hex ? holderList : []),
      signer: () => s.signer, send: c.send, stepMs: 0, fetchFn, log: (l) => logs.push(l), claimsOf: async (fid) => (fid === fedL ? ledger() : null) });
    s.signer = createCensusSigner({ key: p.key, work: censusKeyWork, held: (k) => (toHex(k) === census.hex ? shares : null), check: (request) => s.run.checkOther(request) });
    seats.set(p.hex, s);
  }
  const passAll = async () => { const out = []; for (const [p] of holders) out.push(...(await seats.get(p.hex).run.pass()).map((x) => ({ by: p.hex, ...x }))); return out; };
  const carryAll = async () => { const out = []; for (const [p] of holders) out.push(...(await seats.get(p.hex).run.carry())); return out; };
  return { c, seats, paid, logs, start, live, passAll, carryAll, run: (p) => seats.get(p.hex).run };
}
/** Each output of `tx` to a carrier's peg-in address claims exactly its value (its client's claim). */
const claimAll = (w, tx) => {
  for (const [p] of holders) for (const fid of [fedA, fedB]) for (let n = 0; n < 8; n++) {
    const address = `addr-${p.hex}-${fid}-${n}`, i = tx.outputs.findIndex((o) => toHex(o.script) === toHex(scriptOfAddress(address)));
    if (i >= 0) w.c.claims.set(address, tx.outputs[i].value * 1000n);
  }
};

// ---- THE PURE PART ----
test('the ledger: what a census-key escrow owes is each claim\'s face less what the arbitration set\'s escrow pays it and earlier census-key spends carry, in the ledger\'s order', () => {
  const owed = claimsOwed({ accepted: [claim(2, 500_000, 421), claim(1, 300_000), claim(3, 70_000)], coveredMsat: new Map([[claim(1, 0).nonce, 100_000n]]), assigned: new Map([[claim(3, 0).nonce, 70_000n]]) });
  assert.deepEqual(owed.map((c) => [c.nonce, c.msat]), [[claim(1, 0).nonce, 200_000n], [claim(2, 0).nonce, 500_000n]], 'height, then nonce; fully paid ones gone');
  const id = liquidationClaimsId(owed);
  assert.equal(toHex(id), toHex(liquidationClaimsId(owed.map((c) => ({ ...c })))), 'claims_id is the hash of the claims, in order');
  assert.notEqual(toHex(id), toHex(liquidationClaimsId([...owed].reverse())));
});

const SMALL = 500_000n;          // the carriers' bonds: a claim of 400,000 sat does not fit beside one of 300,000
const spendArgs = (over = {}) => ({ escrow: { txid: b32(0xe1), vout: 2, value: 990_000n }, output: escrowBare, tableId: b32(0x7a), loadHeight: 430, marginMsat: MARGIN, rate: 2n, fallbackBlocks: clocks.fallbackBlocks,
  owed: claimsOwed({ accepted: [claim(1, 300_000_000), claim(2, 400_000_000), claim(3, 50_000_000)] }),
  carriers: [{ key: 'k1', federation: fedB, script: scriptOfAddress('k1'), bondSats: SMALL }, { key: 'k2', federation: fedB, script: scriptOfAddress('k2'), bondSats: SMALL }], ...over });

test('a liquidation escrow spend: claims whole and in order, each to the first carrier with room under its bond, the margin past them, the rest back to the escrow; same bytes for every signer', () => {
  const x = liquidationEscrowSpend(spendArgs()), y = liquidationEscrowSpend(spendArgs());
  assert.ok(x.ok, x.why);
  assert.equal(toHex(x.bytes), toHex(y.bytes)); assert.equal(toHex(x.digest), toHex(y.digest));
  const d = decodeLiquidationEscrowOutputs(x.bytes);
  assert.deepEqual(d.outputs.map((o) => [o.pays, o.value, o.claims]), [['claims_carrier', 300_010n, 1], ['claims_carrier', 450_010n, 2], ['escrow', 990_000n - 750_020n - x.feeSats, undefined]],
    'each output its claims at face, rounded up to the sat, and the 10 sat margin; the rest back to the escrow');
  assert.equal(toHex(encodeLiquidationEscrowOutputs(d)), toHex(x.bytes));
  assert.equal(toHex(d.claimsId), toHex(liquidationClaimsId(x.claims)), 'claims_id names the claims it pays');
  assert.deepEqual(liquidationSlices(d, x.claims).map((s) => s.claims.map((c) => c.msat)), [[300_000_000n], [400_000_000n, 50_000_000n]], 'the second claim does not fit beside the first under its bond: the next carrier, and the third with it');
  assert.equal(toHex(x.spend.tx.outputs[0].script), toHex(Uint8Array.from([0x6a, 64, ...b32(0x7a), ...liquidationEscrowOutputsId(x.outputs)])), 'OP_RETURN payout_table_id || outputs id');
  assert.equal(x.spend.tx.inputs[0].sequence, clocks.fallbackBlocks, 'the census key\'s leaf waits slash_fallback_blocks');
  assert.equal(x.feeSats, 2n * BigInt(x.vsize));
  const rebuilt = liquidationTxOf({ escrow: spendArgs().escrow, output: escrowBare, decoded: d, fallbackBlocks: clocks.fallbackBlocks });
  assert.equal(toHex(serializeSpend({ ...rebuilt, witnesses: [[new Uint8Array(64)]] })), toHex(serializeSpend({ ...x.spend.tx, witnesses: [[new Uint8Array(64)]] })), 'outputs[] rebuild the transaction');
});

test('a short escrow pays what it can in order and the rest wait; no carrier, no claim: not due; after the window the rest goes to the reserves', () => {
  const short = liquidationEscrowSpend(spendArgs({ escrow: { txid: b32(0xe1), vout: 2, value: 600_000n } }));
  assert.ok(short.ok, short.why);
  assert.deepEqual(short.claims.map((c) => c.msat), [300_000_000n], 'the 400,000 sat claim does not fit what is left: it and every claim after it wait');
  assert.deepEqual(liquidationEscrowSpend(spendArgs({ carriers: [] })), { ok: false, due: false, why: 'no carrier has published a peg-in into a safe federation for this escrow' });
  assert.equal(liquidationEscrowSpend(spendArgs({ owed: [] })).due, false);
  const rest = liquidationEscrowSpend(spendArgs({ owed: [], remainder: { federations: RECORDS.filter((f) => f.federation !== fedL) }, carriers: [{ key: 'k1', federation: fedB, script: scriptOfAddress('k1'), bondSats: SMALL }, { key: 'k2', federation: fedA, script: scriptOfAddress('k2'), bondSats: SMALL }] }));
  assert.ok(rest.ok, rest.why);
  assert.ok(rest.outputs.outputs.every((o) => o.pays === 'reserves' || o.pays === 'escrow') && rest.outputs.outputs.some((o) => o.pays === 'reserves'), 'the remainder to the reserves');
  assert.equal(rest.claims.length, 0);
});

// ---- THROUGH THE NODE'S OWN RUNS ----
test('a theft\'s template-3 hold: the census key releases it to one census-key escrow under the zero round id; the escrow pays each claim at face through a carrier in the safest federation', async () => {
  let ledger = { accepted: [claim(1, 300_000_000), claim(2, 120_000_000, 421)], coveredMsat: new Map([[claim(2, 0).nonce, 20_000_000n]]), afterWindow: false };
  const w = world({ ledger: () => ledger });
  // 1. THE FALLBACK at its clock: the roundless table
  assert.deepEqual((await w.passAll()).filter((x) => x.ok), [], 'nothing before slash_fallback_blocks');
  w.c.tip = START_HEIGHT + clocks.fallbackBlocks - 1;
  const fb = await w.passAll();
  assert.equal(w.c.mempool.length, 1, `the fallback went out: ${JSON.stringify(fb.map((x) => x.why))} ${w.logs.join(' | ')}`);
  w.c.mine();
  w.live.entries = w.live.entries.filter((e) => !e.hold);
  const fallback = w.c.mined[0];
  const served = w.run(holders[0][0]).served(w.start.hex);
  const table = decodeSlashPayoutTable(fromHex(served.fallback.table));
  assert.equal(isRoundless(table.roundId), true, 'round_id 32 zero bytes');
  assert.deepEqual([table.entries.length, table.outputs.map((o) => o.pays), toHex(table.proofId)], [0, ['filer', 'escrow'], toHex(proofId)], 'no entries; the filer and one escrow; proof_id the theft\'s');
  assert.equal(toHex(table.outputs[1].script), toHex(escrowBare.script), 'the escrow is under the census key, no panels');
  assert.equal(table.outputs[0].value + table.outputs[1].value + BigInt(served.fallback.feeSats), BOND, 'the whole hold, less the fee');
  assert.equal(toHex(encodeSlashPayoutTable(table)), served.fallback.table);
  // 2. CARRIERS PUBLISH their peg-ins; at the escrow's clock the census key spends it to the claims the ledger leaves
  await w.passAll();
  assert.equal(w.c.mempool.length, 0, 'not before the escrow\'s own clock');
  w.c.tip += clocks.fallbackBlocks;
  const spent = await w.passAll();
  assert.equal(w.c.mempool.length, 1, `${JSON.stringify(spent.map((x) => x.why || x.path))} ${[...new Set(w.logs)].join(' | ')}`);
  w.c.mine();
  const m = w.c.mined[w.c.mined.length - 1];
  assert.equal(m.spends[0], `${fallback.txid}:2`, 'it spends the fallback\'s escrow output');
  const liq = [...w.seats.values()].map((s) => s.run.served(w.start.hex).liquidation).find((l) => l && l.proposals.some((p) => p.txid === m.txid));
  const prop = liq.proposals.find((p) => p.txid === m.txid);
  const d = decodeLiquidationEscrowOutputs(fromHex(prop.outputs)), claims = decodeLiquidationClaims(fromHex(prop.claims));
  assert.deepEqual(claims.map((c) => [c.nonce, c.msat]), [[claim(1, 0).nonce, 300_000_000n], [claim(2, 0).nonce, 100_000_000n]], 'claim 2 at face less what the arbitration set\'s escrow pays it');
  assert.deepEqual(d.outputs.map((o) => o.pays), ['claims_carrier', 'escrow']);
  // 3. THE CARRIER claims its peg-in in the safe federation and pays each claim at face, to the claim's key
  claimAll(w, m.tx);
  const carried = await w.carryAll();
  assert.deepEqual(w.paid.map((x) => [x.federation, x.list.map((y) => [y.key, y.msat])]), [[fedB, [[claim(1, 0).payoutPk, 300_000_000n], [claim(2, 0).payoutPk, 100_000_000n]]]],
    `the lowest-load safe federation (B), never the liquidating one: ${JSON.stringify(carried.filter((x) => x.why))}`);
  assert.equal(w.paid[0].carrier, holders[0][0].hex, 'the holder with the most shares carries first');
  // 4. A LATER CLAIM: the escrow's change pays it, and nothing is paid twice
  ledger = { ...ledger, accepted: [...ledger.accepted, claim(4, 90_000_000, w.c.tip - 1)] };
  await w.passAll();
  w.c.tip += clocks.fallbackBlocks;
  await w.passAll();
  assert.equal(w.c.mempool.length, 1, 'the escrow\'s change is spent for the new claim');
  w.c.mine();
  const m2 = w.c.mined[w.c.mined.length - 1];
  claimAll(w, m2.tx);
  await w.carryAll();
  assert.deepEqual(w.paid.slice(1).flatMap((x) => x.list.map((y) => [y.key, y.msat])), [[claim(4, 0).payoutPk, 90_000_000n]], 'only the new claim: the first two are carried already');
});

test('a holder signs only its own bytes: another outputs id or a height past its tip is refused', async () => {
  const w = world({ ledger: () => ({ accepted: [claim(1, 300_000_000)], coveredMsat: new Map(), afterWindow: false }) });
  w.c.tip = START_HEIGHT + clocks.fallbackBlocks - 1;
  await w.passAll(); w.c.mine(); w.live.entries = w.live.entries.filter((e) => !e.hold);
  await w.passAll();
  const run = w.run(holders[1][0]);
  const ctx = await run.liquidation.contextOf(w.start.hex);
  const at = await run.liquidation.walk(ctx);
  w.c.tip += clocks.fallbackBlocks;
  const ask = (over) => run.checkOther({ kind: 'liquidation-escrow', start: w.start.hex, tableId: ctx.tableId, escrow: at.cur.name, loadHeight: w.c.tip, outputsId: '00'.repeat(32), ...over });
  assert.match((await ask({})).why, /own outputs at/);
  assert.match((await ask({ loadHeight: w.c.tip + 5 })).why, /names a height from/);
  assert.match((await ask({ escrow: `${'ab'.repeat(32)}:1` })).why, /this seat's escrow is/);
});
