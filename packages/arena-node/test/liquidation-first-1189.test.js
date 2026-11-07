// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #1189 TWO LIQUIDATION ESCROWS OF ONE FEDERATION NEVER CARRY ONE CLAIM. Before: "one escrow of a federation at a time" was each seat's own walk (firstOfFederation): an older escrow
// counted as due only once this seat held its carriers' peg-ins, and a spend counted as carrying a claim only once it was on the chain. So a younger escrow's spend for a claim went out
// while the older one's carriers were not heard yet, and when they were, the older one signed a spend for the same claim before the first was mined: both were, the claim paid twice.
// Now a holder writes the claims a spend carries as that start's (CLAIM_LOCK held) before it signs, builds no other start's spend with them, and signs none: any two signing sets of
// the census key meet, so no two escrows get a threshold for one claim.
// The world is liquidation-escrow.test.js's (real keys, real BIP-341 sighashes, a real FROST census key, one small chain) with two thefts of one federation in it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { holdOutputKey, slashStartLeaf } from '../../arena-protocol/src/bond-script.js';
import { arbitrationCommitment } from '../../arena-protocol/src/arbitration-tx.js';
import { serializeSpend } from '../../arena-protocol/src/bond-spend.js';
import { decodeLiquidationClaims } from '../../arena-protocol/src/liquidation-escrow.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
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
const clocks = { holdBlocks: 1, returnBlocks: 36, fallbackBlocks: 24 };
const BOND = 1_000_000n, MATURITY = 600, START_HEIGHT = 400, SLASH_HEIGHT = 399;
const holders = [[person(50), [1, 2]], [person(51), [3]], [person(52), [4]], [person(53), [5]]];
const feeCoin = { txid: b32(0x92), vout: 0, value: 700n, script: fromHex(`5120${'93'.repeat(32)}`) };
const fedL = '1e'.repeat(32), fedA = 'fa'.repeat(32), fedB = 'fb'.repeat(32);
const reserveKey = (fid) => Uint8Array.from([0x02, ...fromHex(fid)]);
const fed = (id, reserve) => ({ federation: id, status: 'OPEN', reserveKey: toHex(reserveKey(id)), reserveSats: String(reserve), exposureCapSats: '1000000' });
const RECORDS = [fed(fedL, 0), fed(fedA, 600000), fed(fedB, 100000)];
const scriptOfAddress = (address) => fromHex(`5120${toHex(taggedHash('ARENA/test/Address', new TextEncoder().encode(address)))}`);
const claim = (n, msat, height = 420) => ({ nonce: toHex(b32(0xc0 + n)), amountMsat: String(msat), payoutPk: `02${toHex(b32(0xd0 + n))}`, height });

// TWO THEFTS OF FEDERATION L: two accused guardians, two bonds, two proofs, two holds
const thefts = [0, 1].map((i) => {
  const accused = person(40 + i), bond = { txid: b32(0x91 + 4 * i), vout: 1 }, proof = Uint8Array.of(0x46, 7 + i, 7 + i);
  const advert = { bondScriptTemplateVersion: 3, censusKey: census.key, ownerPubkey: accused.key, bondMaturityHeight: MATURITY };
  const hold = holdOutputKey({ ownerKey: accused.key, censusKey: census.key, panelA: [], panelB: [], bondMaturity: MATURITY, ...clocks }, { tweakPoint });
  const proofId = taggedHash('ARENA/v1/SlashProof', proof);
  const tx = { version: 2, locktime: 0, inputs: [{ txid: bond.txid, vout: bond.vout, sequence: 0xfffffffd }, { txid: feeCoin.txid, vout: 0, sequence: 0xfffffffd }],
    outputs: [{ value: BOND, script: hold.script }, arbitrationCommitment(proofId, SLASH_HEIGHT, new TextEncoder().encode('arena'))] };
  const raw = serializeSpend({ ...tx, witnesses: [[new Uint8Array(64), new Uint8Array(65), slashStartLeaf(accused.key, census.key), new Uint8Array(65)], [new Uint8Array(64), new Uint8Array(34), new Uint8Array(33)]] });
  return { accused, bond, proof, proofId, advert, hold, start: { raw, txid: parseTransaction(raw).txid, hex: display(parseTransaction(raw).txid) } };
});
const feeFunding = serializeSpend({ version: 2, locktime: 0, inputs: [{ txid: b32(9), vout: 0, sequence: 0 }], outputs: [{ value: 700n, script: feeCoin.script }], witnesses: [[new Uint8Array(64)]] });

function chain(tip) {
  const utxo = new Map(), mempool = [], raws = new Map();
  const c = {
    tip, mined: [], mempool,
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

function world({ ledger, tip = START_HEIGHT + 1 }) {
  const c = chain(tip);
  for (const t of thefts) c.add(t.start.hex, 0, BOND, t.hold.script, START_HEIGHT);
  const urlOf = (k) => `http://seat-${k}`;
  const seats = new Map(), logs = [];
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
  const live = { entries: [...thefts.map((t) => ({ pubkey: t.accused.key, txid: t.bond.txid, vout: t.bond.vout, bondSats: String(BOND), script: fromHex(`5120${'94'.repeat(32)}`), hold: { txid: toHex(t.start.txid), vout: 0, height: START_HEIGHT }, advert: t.advert })),
    ...holders.map(([p], i) => ({ pubkey: p.key, txid: b32(10 + i), vout: 0, bondSats: String(BOND), advert: thefts[0].advert }))] };
  const rawTx = async (txid) => { const t = thefts.find((x) => x.start.hex === txid); return t ? t.start.raw : txid === display(feeCoin.txid) ? feeFunding : c.rawTx(txid); };
  const holderList = holders.map(([p, xs]) => ({ key: p.hex, shares: xs.length }));
  const theftOf = (bytes) => thefts.find((t) => toHex(t.proof) === toHex(bytes));
  const judge = Object.assign(async () => ({ verdict: true, why: 'a theft' }), { read: (bytes) => ({ ok: true, kind: 'theft', roundId: null, contract: null, federationId: fromHex(fedL), nodePubkey: theftOf(bytes).accused.key }) });
  for (const [p, xs] of holders) {
    const shares = { shares: new Map(xs.map((x) => [x, dealt.share(x)])) };
    let made = 0;
    const port = { peginAddress: async () => `addr-${p.hex}-${made++}`, peginClaim: async () => ({ claimedMsat: 0n }), ecashBalance: async () => 0n, payouts: async () => { throw new Error('not here'); } };
    const s = { db: new DatabaseSync(':memory:') };
    s.run = createSlashRelease({ key: p.key, secret: p.secret, networkId: NETWORK_ID_REGTEST, clocks, db: s.db, tweakPoint,
      tipHeight: async () => c.tip, entriesAtTip: async () => live.entries, rawTx, unspent: async (t, v) => !!(await c.txOut(t, v)), txOut: c.txOut,
      fetchProof: async (id) => (thefts.find((t) => toHex(t.proofId) === toHex(id)) || { proof: null }).proof, judge, panelsOf: () => ({ ok: false }), seatsOf: async () => [], lossesFor: async () => ({ ok: false, why: 'no round' }),
      federations: async () => RECORDS, federationsAt: async () => RECORDS, portFor: async () => port, scriptOf: scriptOfAddress, reserveKeyOf: async (fid) => reserveKey(fid), urlOf,
      heldKey: (k) => (toHex(k) === census.hex ? shares : null), thresholdOf: (k) => (k === census.hex ? THRESHOLD : null), holdersOf: async (k) => (k === census.hex ? holderList : []),
      signer: () => s.signer, send: c.send, stepMs: 0, fetchFn, log: (l) => logs.push(l), claimsOf: async (fid) => (fid === fedL ? ledger() : null) });
    s.signer = createCensusSigner({ key: p.key, work: censusKeyWork, held: (k) => (toHex(k) === census.hex ? shares : null), rosterOf: () => ({ total: 5, threshold: THRESHOLD }), check: (request) => s.run.checkOther(request) });
    seats.set(p.hex, s);
  }
  const passAll = async () => { const out = []; for (const [p] of holders) out.push(...(await seats.get(p.hex).run.pass()).map((x) => ({ by: p.hex, ...x }))); return out; };
  return { c, seats, logs, live, passAll };
}

/** The claims each mined escrow spend carries, by the proposals the seats serve. */
const carriedBy = (w) => {
  const props = new Map();
  for (const s of w.seats.values()) for (const t of thefts) for (const p of ((s.run.served(t.start.hex) || {}).liquidation || { proposals: [] }).proposals) props.set(p.txid, { start: t.start.hex, claims: decodeLiquidationClaims(fromHex(p.claims)) });
  return w.c.mined.filter((m) => props.has(m.txid)).map((m) => ({ txid: m.txid, ...props.get(m.txid) }));
};

test('#1189 an older escrow whose carriers are heard late does not carry a claim a younger escrow\'s spend already carries', async () => {
  let ledger = { accepted: [claim(1, 300_000_000)], coveredMsat: new Map(), afterWindow: false };
  const w = world({ ledger: () => ledger });
  // 1. BOTH FALLBACKS, each to its census-key escrow of federation L
  w.c.tip = START_HEIGHT + clocks.fallbackBlocks - 1;
  await w.passAll(); await w.passAll();
  assert.equal(w.c.mempool.length, 2, `both fallbacks went out: ${[...new Set(w.logs)].slice(-4).join(' | ')}`);
  w.c.mine();
  w.live.entries = w.live.entries.filter((e) => !e.hold);
  // 2. THE CARRIERS PUBLISH their peg-ins for both escrows
  await w.passAll();
  const order = [...thefts].map((t) => t.start.hex).sort();          // same height: the older is the lower start txid (slash_holds ORDER BY height, start)
  const tableOf = (start) => [...w.seats.values()][0].run.served(start).liquidation.tableId;
  const older = order[0], younger = order[1];
  const hidden = new Map();
  // 3. THE OLDER ESCROW'S CARRIERS NOT HEARD YET, at any seat
  for (const [k, s] of w.seats) { hidden.set(k, s.db.prepare('SELECT * FROM slash_carrier_pegins WHERE table_id = ?').all(tableOf(older))); s.db.prepare('DELETE FROM slash_carrier_pegins WHERE table_id = ?').run(tableOf(older)); }
  assert.ok([...hidden.values()].every((rows) => rows.length), 'each seat had the older escrow\'s carriers');
  w.c.tip += clocks.fallbackBlocks;
  await w.passAll();
  assert.equal(w.c.mempool.length, 1, `the younger escrow's spend went out: ${[...new Set(w.logs)].slice(-4).join(' | ')}`);
  // 4. THEY ARE HEARD, before that spend is mined
  for (const [k, s] of w.seats) for (const r of hidden.get(k)) s.db.prepare('INSERT OR IGNORE INTO slash_carrier_pegins (table_id, escrow, federation, node, script, signature) VALUES (?, ?, ?, ?, ?, ?)').run(r.table_id, r.escrow, r.federation, r.node, r.script, r.signature);
  const said = [...(await w.passAll()), ...(await w.passAll())];
  w.c.mine();
  const spends = carriedBy(w);
  const carrying = spends.filter((x) => x.claims.some((c) => c.nonce === claim(1, 0).nonce));
  console.log(`  FACTS #1189: escrow spends mined carrying claim 1: ${carrying.length} (${carrying.map((x) => (x.start === older ? 'older' : 'younger')).join(', ')}); the older one says: ${String((said.find((x) => x.start === older && x.why) || {}).why || 'nothing').slice(0, 90)}`);
  assert.equal(carrying.length, 1, 'one escrow carries the claim');
  assert.equal(carrying[0].start, younger);
  // 5. A LATER CLAIM: the older escrow is first again, and pays it, and only it
  ledger = { ...ledger, accepted: [...ledger.accepted, claim(2, 90_000_000, w.c.tip - 1)] };
  await w.passAll(); await w.passAll();
  w.c.mine();
  const later = carriedBy(w).filter((x) => !spends.some((y) => y.txid === x.txid));
  console.log(`  FACTS #1189: then claim 2: carried by ${later.map((x) => `${x.start === older ? 'older' : 'younger'} [${x.claims.map((c) => (c.nonce === claim(1, 0).nonce ? 1 : c.nonce === claim(2, 0).nonce ? 2 : '?')).join(',')}]`).join('; ')}`);
  assert.deepEqual(later.map((x) => [x.start, x.claims.map((c) => c.nonce)]), [[older, [claim(2, 0).nonce]]], 'the older escrow pays the new claim, and not claim 1 again');
});

test('#1189 a holder that agreed to one escrow\'s spend of a claim signs no other escrow\'s spend of it, whatever the filer built', async () => {
  const ledger = { accepted: [claim(1, 300_000_000)], coveredMsat: new Map(), afterWindow: false };
  const w = world({ ledger: () => ledger });
  w.c.tip = START_HEIGHT + clocks.fallbackBlocks - 1;
  await w.passAll(); await w.passAll(); w.c.mine();
  w.live.entries = w.live.entries.filter((e) => !e.hold);
  await w.passAll();
  w.c.tip += clocks.fallbackBlocks;
  const [older, younger] = thefts.map((t) => t.start.hex).sort();
  const [a, b] = [...w.seats.values()].slice(1, 3);
  const spendOf = async (s, start) => { const ctx = await s.run.liquidation.contextOf(start), at = await s.run.liquidation.walk(ctx); return { ctx, at, b: await s.run.liquidation.buildAt(ctx, at, w.c.tip) }; };
  const ask = (s, start, x) => s.run.checkOther({ kind: 'liquidation-escrow', start, tableId: x.ctx.tableId, escrow: x.at.cur.name, loadHeight: w.c.tip, outputsId: toHex(x.b.outputsId) });
  // seat A has not heard the older escrow's carriers: the younger is first by its walk, and it agrees to the younger's spend of claim 1
  const tableOf = (start) => a.run.served(start).liquidation.tableId;
  const kept = a.db.prepare('SELECT * FROM slash_carrier_pegins WHERE table_id = ?').all(tableOf(older));
  a.db.prepare('DELETE FROM slash_carrier_pegins WHERE table_id = ?').run(tableOf(older));
  const y = await spendOf(a, younger);
  const agreed = await ask(a, younger, y);
  assert.ok(agreed.ok, agreed.why);
  // then it hears them; seat B, which never agreed to anything, files the older escrow's spend of claim 1 and asks A
  for (const r of kept) a.db.prepare('INSERT OR IGNORE INTO slash_carrier_pegins (table_id, escrow, federation, node, script, signature) VALUES (?, ?, ?, ?, ?, ?)').run(r.table_id, r.escrow, r.federation, r.node, r.script, r.signature);
  const o = await spendOf(b, older);
  assert.ok(o.b.ok && o.b.claims.some((c) => c.nonce === claim(1, 0).nonce), 'B builds the older escrow\'s spend of claim 1');
  const late = await ask(a, older, o);
  console.log(`  FACTS #1189: seat A agreed to the younger escrow's spend of claim 1; asked for the older's: ${late.ok ? 'SIGNS' : `refuses: ${late.why.slice(0, 90)}`}`);
  assert.equal(late.ok, false, 'no second escrow gets A\'s signature for claim 1');
  assert.equal(a.run.liquidation.claimState(fedL, claim(1, 0).nonce).state, 'held');
});
