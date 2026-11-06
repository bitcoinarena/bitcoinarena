// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SLASH START'S FEE COIN IS FUNDED ONCE, ACROSS A STOP (kanban #1191, the state machine audit of 2026-11-06). Before, the coin funded for a proof was kept in memory until
// the start's row was written: a seat that funded it and then stopped - before the holders answered, while the wallet's answer was on its way, or after the start went out -
// came back with nothing, funded a second coin at the same script, and (in the last case) never swept the first start's repaid fee. Now the coin is FEE_COIN on disk
// (none -> funding -> funded -> filing -> filed), each step written before the wallet or the chain is asked. Real keys and a real FROST signature of the census key: the start
// that goes out is the bytes the holders signed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import * as starter from '../src/slash-start-run.js';

const { createSlashStarter } = starter;
// slash-start-run.js FEE_COIN (spelled out, so the test runs on the code before it too)
const FEE_COIN = starter.FEE_COIN || { NONE: 'none', FUNDING: 'funding', FUNDED: 'funded', FILING: 'filing', FILED: 'filed' };
import { createCensusSigner } from '../src/census-sign.js';
import { censusKeyWork } from '../src/census-key-work.js';
import { BOND_TEMPLATE_V3 } from '../../arena-protocol/src/bond-script.js';
import { slashStartDigest } from '../../arena-protocol/src/slash-start.js';
import { encodeCensusKeyRecord } from '../../arena-protocol/src/census-key.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { taggedHash, toHex, fromHex } from '../../arena-protocol/src/hash.js';

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const b32 = (n) => new Uint8Array(32).fill(n);
const secret = (n) => taggedHash('ARENA/test/FeeCoin1191', Uint8Array.of(n));
const toScalar = (b) => BigInt(`0x${toHex(b)}`) % N;
// THE CENSUS KEY: degree 3 under an even key, threshold 4, x 1..6 (as census-sign.test.js deals it)
let a0 = toScalar(secret(1));
if (secp256k1.getPublicKey(secret(1), true)[0] === 3) a0 = N - a0;
const co = [a0, toScalar(secret(2)), toScalar(secret(3)), toScalar(secret(4))];
const share = (x) => co.reduce((sum, c, i) => (sum + c * BigInt(x) ** BigInt(i)) % N, 0n);
const censusKey = schnorr.getPublicKey(secret(1));
const record = encodeCensusKeyRecord({ networkId: new Uint8Array(32), epoch: 1, publicKey: censusKey, censusHeight: 100, totalShares: 6, threshold: 4, transcriptHash: new Uint8Array(32) });

const filerSecret = secret(20), filerKey = schnorr.getPublicKey(filerSecret);
const accused = schnorr.getPublicKey(secret(21));
const entry = { txid: b32(0x71), vout: 1, pubkey: accused, bondSats: '1000000', script: fromHex(`5120${'74'.repeat(32)}`), hold: null,
  advert: { bondScriptTemplateVersion: BOND_TEMPLATE_V3, censusKey, bondMaturityHeight: 600, ownerPubkey: accused } };
const holdScript = fromHex(`5120${'75'.repeat(32)}`);
const bytes = Uint8Array.of(7, 7, 7);
const said = { ok: true, bond: { txid: entry.txid, vout: 1 }, roundId: b32(0x51), contract: {} };

// THE HOLDERS: each signs the digest of the very transaction it is asked about (a holder's own checks are slash-start-run's `check`, not this test's)
const txOfJson = (t) => ({ version: t.version, locktime: t.locktime, inputs: t.inputs.map((i) => ({ txid: fromHex(i.txid), vout: i.vout, sequence: i.sequence })), outputs: t.outputs.map((o) => ({ value: BigInt(o.value), script: fromHex(o.script) })) });
const holder = (n, xs) => ({ url: `http://h${n}`, signer: createCensusSigner({ key: schnorr.getPublicKey(secret(30 + n)), work: censusKeyWork, held: () => ({ shares: new Map(xs.map((x) => [x, share(x)])), record }),
  check: async (req) => ({ ok: true, publicKey: censusKey, digest: slashStartDigest({ tx: txOfJson(req.tx), prevouts: req.prevouts.map((p) => ({ value: BigInt(p.value), script: fromHex(p.script) })), nodeKey: accused, censusKey }) }) }) });
const holders = [holder(1, [1, 2]), holder(2, [3, 4]), holder(3, [5, 6])];
const wire = (up) => async (url, init) => {
  if (!up()) throw new Error('connect ECONNREFUSED');
  const h = holders.find((x) => url.startsWith(x.url));
  const body = JSON.parse(init.body);
  return { json: async () => (url.endsWith('/commit') ? h.signer.takeCommit(body) : h.signer.takeShare(body)) };
};

/** One seat on `db`: `wallet` counts what was funded, `chain` what was sent. */
function seat({ db, wallet, chain, up = () => true, feeCoin = null, feeFind, send = null }) {
  const fund = feeCoin || (async (spk, value) => { wallet.funded.push({ spk: toHex(spk), value }); return { ok: true, txid: toHex(taggedHash('ARENA/test/Fund', Uint8Array.of(wallet.funded.length))), vout: 0, value: BigInt(value) }; });
  return createSlashStarter({ key: filerKey, network: 'regtest', db, store: { held: () => null }, thresholdOf: () => 4, totalOf: () => 6, tipHeight: async () => 500,
    entriesAtTip: async () => [entry], heldProofs: async () => [], bytesOf: () => null, judge: Object.assign(async () => ({ verdict: true }), { read: () => said }),
    holdsFor: () => ({ holds: [{ script: holdScript }], presig: new Uint8Array(65).fill(3), holdScript }), feeCoin: fund, ...(feeFind === undefined ? {} : { feeFind }),
    send: send || (async (hex) => { const txid = toHex([...parseTransaction(fromHex(hex)).txid].reverse()); if (chain.sent.includes(txid)) throw new Error('txn-already-in-mempool'); chain.sent.push(txid); return txid; }),
    urlsOf: () => holders.map((h) => h.url), fetchFn: wire(up), feeSecret: (id) => taggedHash('ARENA/v1/SlashFeeKey', Uint8Array.from([...filerSecret, ...id])), log: () => {} });
}
const coinState = (db) => { try { const r = db.prepare('SELECT state FROM slash_fee_coins').get(); return r ? r.state : FEE_COIN.NONE; } catch { return 'no table'; } };

test('kanban #1191: a start that gathered too few shares, then a restart: the fee coin funded before is the one used, never a second', async () => {
  const db = new DatabaseSync(':memory:'), wallet = { funded: [] }, chain = { sent: [] };
  let up = false;
  const first = await seat({ db, wallet, chain, up: () => up }).file({ bytes, said, entry, entries: [entry] });
  assert.equal(first.ok, false, 'no holder answers');
  assert.equal(wallet.funded.length, 1);
  // THE SEAT STOPS AND COMES BACK: the holders answer now
  up = true;
  const again = await seat({ db, wallet, chain }).file({ bytes, said, entry, entries: [entry] });
  const facts = { feeCoinsFunded: wallet.funded.length, filed: again.ok, coin: coinState(db) };
  console.log('  FACTS (#1191, restart between funding and the start):', JSON.stringify(facts));
  assert.equal(again.ok, true, again.why);
  assert.equal(wallet.funded.length, 1, `${wallet.funded.length} fee coins funded at one script`);
  const start = parseTransaction(fromHex(db.prepare('SELECT raw FROM slash_fee_coins').get().raw));
  assert.equal(toHex([...start.inputs[1].previousTxid].reverse()), toHex(taggedHash('ARENA/test/Fund', Uint8Array.of(1))), 'the start spends the coin funded first');
  assert.equal(coinState(db), FEE_COIN.FILED);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM slash_starts').get().n, 1);
});

test('kanban #1191: a stop while the wallet funded (the answer never heard): the coin is found by its script, not funded again; with no way to look, held', async () => {
  const db = new DatabaseSync(':memory:'), wallet = { funded: [] }, chain = { sent: [] };
  // THE WALLET SENT IT, THE ANSWER IS LOST
  const lost = async (spk, value) => { wallet.funded.push({ spk: toHex(spk), value, txid: 'aa'.repeat(32) }); throw new Error('socket hang up'); };
  await assert.rejects(Promise.resolve().then(() => seat({ db, wallet, chain, feeCoin: lost }).file({ bytes, said, entry, entries: [entry] })).then((r) => { if (!r.ok) throw new Error(r.why); }), /socket hang up/);
  assert.equal(coinState(db), FEE_COIN.FUNDING, 'funding on disk before the wallet was asked');
  // NO WAY TO LOOK: held, nothing funded
  const held = await seat({ db, wallet, chain, feeFind: null }).file({ bytes, said, entry, entries: [entry] });
  assert.equal(held.ok, false);
  assert.equal(held.held, true);
  assert.equal(wallet.funded.length, 1);
  // THE WALLET'S HISTORY HAS IT AT THAT SCRIPT
  const find = async (spk) => { const f = wallet.funded.find((x) => x.spk === toHex(spk)); return f ? { txid: f.txid, vout: 0, value: BigInt(f.value) } : null; };
  const r = await seat({ db, wallet, chain, feeFind: find }).file({ bytes, said, entry, entries: [entry] });
  console.log('  FACTS (#1191, stop while funding):', JSON.stringify({ feeCoinsFunded: wallet.funded.length, filed: r.ok, coin: coinState(db) }));
  assert.equal(r.ok, true, r.why);
  assert.equal(wallet.funded.length, 1, 'found, not funded again');
  const start = parseTransaction(fromHex(db.prepare('SELECT raw FROM slash_fee_coins').get().raw));
  assert.equal(toHex([...start.inputs[1].previousTxid].reverse()), 'aa'.repeat(32));
  // A FUNDING THE WALLET NEVER SENT is funded once more
  const db2 = new DatabaseSync(':memory:'), w2 = { funded: [] };
  db2.exec(`CREATE TABLE IF NOT EXISTS slash_fee_coins (proof_id BLOB PRIMARY KEY, state TEXT NOT NULL, txid TEXT, vout INTEGER, value TEXT, raw TEXT, start TEXT, bond TEXT, rate INTEGER, at_ms INTEGER NOT NULL)`);
  db2.prepare('INSERT INTO slash_fee_coins (proof_id, state, at_ms) VALUES (?, ?, 0)').run(taggedHash('ARENA/v1/SlashProof', bytes), FEE_COIN.FUNDING);
  const r2 = await seat({ db: db2, wallet: w2, chain: { sent: [] }, feeFind: async () => null }).file({ bytes, said, entry, entries: [entry] });
  assert.equal(r2.ok, true, r2.why);
  assert.equal(w2.funded.length, 1);
});

test('kanban #1191: a stop after the start went out and before its row: the same bytes are sent again, the start is recorded, and no second coin or start follows', async () => {
  const db = new DatabaseSync(':memory:'), wallet = { funded: [] }, chain = { sent: [] };
  // THE SEND REACHES THE CHAIN AND THE PROCESS DIES BEFORE IT ANSWERS (a promise that never settles)
  const dying = async (hex) => { chain.sent.push(toHex([...parseTransaction(fromHex(hex)).txid].reverse())); return new Promise(() => {}); };
  seat({ db, wallet, chain, send: dying }).file({ bytes, said, entry, entries: [entry] });
  const stop = Date.now() + 20000;
  while (!chain.sent.length && Date.now() < stop) await new Promise((r) => setTimeout(r, 20));
  assert.equal(chain.sent.length, 1, 'the start went out');
  // BACK: the chain holds the start, so the census shows the bond held - no pass would file it again
  const back = seat({ db, wallet, chain });
  const done = await back.pass();
  const facts = { feeCoinsFunded: wallet.funded.length, startsSent: new Set(chain.sent).size, startRows: db.prepare('SELECT COUNT(*) AS n FROM slash_starts').get().n,
    sweepRows: db.prepare('SELECT COUNT(*) AS n FROM slash_fee_sweeps').get().n, coin: coinState(db) };
  console.log('  FACTS (#1191, stop after the send):', JSON.stringify(facts));
  assert.ok(done.some((d) => d.resumed && d.ok), JSON.stringify(done));
  assert.deepEqual(facts, { feeCoinsFunded: 1, startsSent: 1, startRows: 1, sweepRows: 1, coin: FEE_COIN.FILED });
  assert.equal(db.prepare('SELECT txid FROM slash_starts').get().txid, chain.sent[0], 'its row names the start that went out, so its repaid fee is swept');
});
