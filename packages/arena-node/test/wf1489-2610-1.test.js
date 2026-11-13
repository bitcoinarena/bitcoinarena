// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #2610 (the posting side of #2608, ruling #2600): a leaving node funds and sends OP_RETURN "ARN" 'L' || notice || signature (#2612) from its
// wallet, waits until it is confirmed on its own chain, and only then publishes the notice with the anchor's txid and block hash - once per
// notice, across restarts. The seats' #2608 reader (absences.js offerAnchored / departureFor) takes what it publishes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { departureId, departureAnchorScript, DEPARTURE_ANCHOR_HEIGHT, DEPARTURE_ANCHOR_SLACK } from '../../arena-protocol/src/absence.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { createAbsences, readDepartureHex, departureHex } from '../src/absences.js';
import { ownDeparture } from '../src/absence-producer.js';
import { createDepartureAnchors, bondCliAnchorWallet, installerAnchorWallet, PHASE } from '../src/departure-anchor.js';

const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const FED = new Uint8Array(32).fill(0x27);
const keys = Array.from({ length: 4 }, (_, i) => { const secret = new Uint8Array(32).fill(i + 41); return { secret, pub: schnorr.getPublicKey(secret) }; });
const peerOf = (i) => Uint8Array.from([2, ...new Uint8Array(32).fill(0x70 + i)]);
const record = { federationId: FED, nominal: 4, guardians: keys.map((k, i) => ({ peerKey: peerOf(i), nodePubkey: k.pub })) };
const NOTICE = 432;
const GATE = DEPARTURE_ANCHOR_HEIGHT.testnet4;
const ownNotice = (tip, i = 0) => ownDeparture({ own: { federation: toHex(FED), peerKey: peerOf(i) }, tip, departureNotice: NOTICE, nodePubkey: keys[i].pub,
  sign: (m) => schnorr.sign(m, keys[i].secret), slack: DEPARTURE_ANCHOR_SLACK });

const u32le = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const u64le = (v) => { const b = []; let x = BigInt(v); for (let i = 0; i < 8; i++) { b.push(Number(x & 255n)); x >>= 8n; } return b; };
let spent = 0;
function rawTx(outs) {
  const prev = new Array(32).fill(0); prev[0] = ++spent & 255; prev[1] = (spent >> 8) & 255;   // each funding spends another coin
  const b = [...u32le(2), 1, ...prev, ...u32le(0), 0, ...u32le(0xfffffffd), outs.length];
  for (const o of outs) b.push(...u64le(o.value), o.script.length, ...o.script);
  b.push(...u32le(0));
  return toHex(Uint8Array.from(b));
}
const txidOf = (hex) => toHex(Uint8Array.from(parseTransaction(fromHex(hex)).txid).reverse());

// A BITCOIND WITH A WALLET: the wallet RPC the bond wallet uses (add-bond-wallet.js bondCliFrom's cli), its mempool and blocks
function fakeBitcoind({ tip = GATE + 10, funds = true } = {}) {
  const blocks = [];                       // [{ height, hash, txids }] of the main chain above `base`
  const base = tip;
  const mempool = new Map(); const known = new Map();   // txid -> hex
  const calls = []; const sent = [];
  let nHash = 0;
  const heightNow = () => base + blocks.length;
  const where = (txid) => blocks.find((b) => b.txids.includes(txid)) || null;
  const cli = (...args) => {
    const a = args[0] === '-named' ? args.slice(1) : args;
    calls.push(a);
    const named = Object.fromEntries(a.slice(1).filter((x) => typeof x === 'string' && x.includes('=')).map((x) => [x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1)]));
    switch (a[0]) {
      case 'walletcreatefundedpsbt': {
        if (!funds) { const e = new Error('Insufficient funds'); e.stderr = 'error code: -4\nInsufficient funds'; throw e; }
        // as Core writes a `data` output: one push, OP_PUSHDATA1 above 75 bytes
        const outs = JSON.parse(named.outputs).map((o) => { const p = fromHex(o.data); return { value: 0n, script: Uint8Array.from(p.length > 75 ? [0x6a, 0x4c, p.length, ...p] : [0x6a, p.length, ...p]) }; });
        const hex = rawTx([...outs, { value: 90000n, script: Uint8Array.from([0x00, 0x14, ...new Array(20).fill(9)]) }]);
        return JSON.stringify({ psbt: `psbt:${hex}`, fee: 0.00000302, changepos: 1, options: JSON.parse(named.options) });
      }
      case 'walletprocesspsbt': return JSON.stringify({ psbt: a[1], complete: true });
      case 'finalizepsbt': return JSON.stringify({ hex: String(a[1]).slice(5), complete: true });
      case 'testmempoolaccept': return JSON.stringify(JSON.parse(a[1]).map((h) => ({ txid: txidOf(h), allowed: true })));
      case 'sendrawtransaction': {
        const t = txidOf(a[1]); sent.push(t);
        if (where(t)) { const e = new Error('Transaction outputs already in utxo set'); e.stderr = 'error code: -27'; throw e; }
        mempool.set(t, a[1]); known.set(t, a[1]); return t;
      }
      case 'gettransaction': {
        const t = a[1]; if (!known.has(t)) throw new Error('Invalid or non-wallet transaction id');
        const b = where(t); return JSON.stringify(b ? { confirmations: heightNow() - b.height + 1, blockhash: b.hash, blockheight: b.height } : { confirmations: 0 });
      }
      default: throw new Error(`no ${a[0]} in this fake`);
    }
  };
  return {
    cli, calls, sent, mempool,
    mine() { const hash = toHex(new Uint8Array(32).fill(0)).slice(0, 56) + String(++nHash).padStart(8, '0'); const txids = [...mempool.keys()]; mempool.clear(); blocks.push({ height: heightNow() + 1, hash, txids }); return { hash, height: heightNow(), txids }; },
    // a reorg: the newest block replaced by one without its transactions (they go back to the mempool)
    reorg() { const b = blocks.pop(); for (const t of b.txids) mempool.set(t, known.get(t)); return b; },
    // the node's chain (server.js: chainTip + ballot.blockHashAt + chainBlockTxids) and the seats' reader (main.js ballot.confirmedTx)
    chain: { tip: async () => heightNow(), blockAt: async (h) => { const b = blocks.find((x) => x.height === h); return b ? { hash: b.hash, txids: b.txids } : (h <= heightNow() ? { hash: 'ee'.repeat(32), txids: [] } : null); } },
    confirmedTx: async (txid, blockHash) => { const b = blocks.find((x) => x.hash === blockHash); return b && b.txids.includes(txid) ? { raw: fromHex(known.get(txid)), height: b.height } : null; },
    known,
  };
}
const memStore = () => { let file = null; return { read: () => (file ? JSON.parse(file) : null), write: (v) => { file = JSON.stringify(v); }, peek: () => (file ? JSON.parse(file) : null) }; };
const builds = (btc) => btc.calls.filter((c) => c[0] === 'walletcreatefundedpsbt').length;

test('#2610 the anchor transaction carries exactly OP_RETURN "ARN" \'L\' || notice || signature (#2612), funded from the bond wallet at 2 sat/vB', async () => {
  const btc = fakeBitcoind();
  const d = ownNotice(GATE + 10);
  const published = [];
  const anchors = createDepartureAnchors({ wallet: bondCliAnchorWallet(btc.cli), chain: btc.chain, confirmedTx: btc.confirmedTx, publish: async (x) => { published.push(x); return { postedTo: 3, of: 3 }; } });
  const r = await anchors.anchor(d);
  assert.equal(r.phase, PHASE.SENT);
  const fund = btc.calls.find((c) => c[0] === 'walletcreatefundedpsbt');
  assert.deepEqual(JSON.parse(fund.find((x) => x.startsWith('outputs=')).slice(8)), [{ data: `41524e4c${departureHex(d).slice(0, (108 + 64) * 2)}` }]);
  assert.equal(JSON.parse(fund.find((x) => x.startsWith('options=')).slice(8)).fee_rate, 2);
  const tx = parseTransaction(fromHex(btc.known.get(r.txid)));
  const ret = tx.outputs.filter((o) => o.script[0] === 0x6a);
  assert.equal(ret.length, 1);
  assert.equal(toHex(ret[0].script), `6a4cb041524e4c${departureHex(d).slice(0, (108 + 64) * 2)}`, 'OP_RETURN, a 176-byte OP_PUSHDATA1: "ARN" \'L\', the notice and its signature (#2612)');
  assert.equal(toHex(ret[0].script), toHex(departureAnchorScript(d)), 'the script #2608 reads');
  assert.deepEqual([btc.sent, r.feeSats], [[r.txid], '302']);
  // a wallet without funds sends nothing and says why
  const poor = createDepartureAnchors({ wallet: bondCliAnchorWallet(fakeBitcoind({ funds: false }).cli), chain: btc.chain });
  const p = await poor.anchor(ownNotice(GATE + 10, 1));
  assert.equal(p.ok, false); assert.match(p.why, /too little/);
});

test('#2610 the notice is published with its anchor only once the anchor is confirmed - and the seats\' #2608 reader takes it', async () => {
  const btc = fakeBitcoind();
  const T = GATE + 10;
  const d = ownNotice(T);
  assert.equal(d.leaveAfterHeight, T + NOTICE + DEPARTURE_ANCHOR_SLACK);
  const published = [];
  const anchors = createDepartureAnchors({ wallet: bondCliAnchorWallet(btc.cli), chain: btc.chain, confirmedTx: btc.confirmedTx, publish: async (x) => { published.push(x); return { postedTo: 7, of: 7 }; } });
  await anchors.anchor(d);
  await anchors.pass(); await anchors.pass();
  assert.equal(published.length, 0, 'in the mempool: not published');
  assert.equal(anchors.recordOf(d).phase, PHASE.SENT);
  const blk = btc.mine();
  const [r] = await anchors.pass();
  assert.deepEqual([r.phase, r.height, r.blockHash, published.length], [PHASE.PUBLISHED, blk.height, blk.hash, 1]);
  assert.deepEqual(published[0].anchor, { txid: r.txid, blockHash: blk.hash }, 'the anchor\'s txid and block hash, no height');
  await anchors.pass();
  assert.equal(published.length, 1, 'published once');
  // A SEAT (absences.js, #2608): the wire form read back, the anchor read on its own chain, DEPARTED from leave_after
  const wire = departureHex(published[0]);
  assert.equal(wire.length, (108 + 64 + 64) * 2);
  const seat = createAbsences({ verify, confirmedTx: btc.confirmedTx, anchorGate: GATE });
  const took = await seat.offerAnchored(readDepartureHex(wire));
  assert.equal(took.ok, true);
  assert.equal(seat.departureFor(record, peerOf(0), NOTICE, blk.height + NOTICE - 1).ok, false);
  const due = seat.departureFor(record, peerOf(0), NOTICE, d.leaveAfterHeight);
  assert.deepEqual([due.ok, due.sinceHeight], [true, d.leaveAfterHeight], 'the producer\'s slack covers the anchor\'s wait');
  // with depth 3: confirmed once is not enough
  const btc2 = fakeBitcoind(); const pub2 = [];
  const deep = createDepartureAnchors({ wallet: bondCliAnchorWallet(btc2.cli), chain: btc2.chain, confirmedTx: btc2.confirmedTx, depth: 3, publish: async (x) => { pub2.push(x); return { postedTo: 1, of: 1 }; } });
  await deep.anchor(d); btc2.mine();
  assert.equal((await deep.pass())[0].phase, PHASE.SENT); btc2.mine();
  assert.equal(pub2.length, 0); btc2.mine();
  assert.equal((await deep.pass())[0].phase, PHASE.PUBLISHED);
});

test('#2610 a restart never posts a second anchor for the same notice: the record is written before the broadcast', async () => {
  const btc = fakeBitcoind();
  const d = ownNotice(GATE + 20);
  const store = memStore();
  // CRASH AFTER THE WRITE, BEFORE THE BROADCAST: the send throws as a dying process would leave it
  let die = true;
  const wallet = bondCliAnchorWallet(btc.cli);
  const dying = { ...wallet, send: async (hex) => { if (die) throw new Error('killed'); return wallet.send(hex); } };
  const first = createDepartureAnchors({ wallet: dying, chain: btc.chain, confirmedTx: btc.confirmedTx, store });
  const a = await first.anchor(d);
  assert.equal(a.phase, PHASE.BUILT);
  const kept = store.peek().anchors[toHex(departureId(d))];
  assert.equal(kept.txid, a.txid); assert.ok(kept.hex, 'the signed bytes are on disk');
  assert.equal(btc.sent.length, 0);
  die = false;
  // the restarted node: a Leave again, the minute's pass, and two asks at once - one transaction, the same bytes
  const published = [];
  const again = createDepartureAnchors({ wallet: bondCliAnchorWallet(btc.cli), chain: btc.chain, confirmedTx: btc.confirmedTx, store, publish: async (x) => { published.push(x); return { postedTo: 2, of: 2 }; } });
  const [x, y] = await Promise.all([again.anchor(d), again.anchor(d)]);
  await again.pass();
  assert.deepEqual([x.txid, y.txid], [a.txid, a.txid]);
  assert.equal(builds(btc), 1, 'funded once');
  assert.deepEqual([...new Set(btc.sent)], [a.txid], 'only that transaction was ever sent');
  // CRASH AFTER THE BROADCAST: a third start finds it sent, and confirmed; publishes it
  btc.mine();
  const third = createDepartureAnchors({ wallet: bondCliAnchorWallet(btc.cli), chain: btc.chain, confirmedTx: btc.confirmedTx, store, publish: async (z) => { published.push(z); return { postedTo: 2, of: 2 }; } });
  const r = await third.anchor(d);
  assert.deepEqual([r.phase, r.txid, builds(btc), published.length], [PHASE.PUBLISHED, a.txid, 1, 1]);
  // and once published, a fourth start does nothing again
  const fourth = createDepartureAnchors({ wallet: bondCliAnchorWallet(btc.cli), chain: btc.chain, confirmedTx: btc.confirmedTx, store, publish: async (z) => { published.push(z); return { postedTo: 2, of: 2 }; } });
  await fourth.anchor(d); await fourth.pass();
  assert.deepEqual([builds(btc), published.length], [1, 1]);
});

test('#2610 a reorg that takes the anchor\'s block sends it back to be found again, and the notice is published with its new block', async () => {
  const btc = fakeBitcoind();
  const d = ownNotice(GATE + 30);
  const published = [];
  const anchors = createDepartureAnchors({ wallet: bondCliAnchorWallet(btc.cli), chain: btc.chain, confirmedTx: btc.confirmedTx, publish: async (x) => { published.push(x); return { postedTo: 1, of: 1 }; } });
  await anchors.anchor(d); const b1 = btc.mine(); await anchors.pass();
  assert.equal(published.at(-1).anchor.blockHash, b1.hash);
  btc.reorg();
  assert.equal((await anchors.pass())[0].phase, PHASE.SENT);
  const b2 = btc.mine();
  const [r] = await anchors.pass();
  assert.deepEqual([r.phase, r.blockHash, published.length, builds(btc)], [PHASE.PUBLISHED, b2.hash, 2, 1], 'the same transaction, its new block');
});

test('#2610 by hand: an anchor the owner sent himself is followed by its txid (no wallet here), found on the chain, then published', async () => {
  const btc = fakeBitcoind();
  const d = ownNotice(GATE + 40);
  const none = createDepartureAnchors({ chain: btc.chain, confirmedTx: btc.confirmedTx });
  const no = await none.anchor(d);
  assert.equal(no.ok, false);
  assert.ok(no.why.includes(toHex(departureAnchorScript(d))), 'it names the script to send');
  // the owner sends it with bitcoin-cli
  const hex = rawTx([{ value: 0n, script: departureAnchorScript(d) }]);
  btc.cli('sendrawtransaction', hex);
  const published = [];
  const byHand = createDepartureAnchors({ chain: btc.chain, confirmedTx: btc.confirmedTx, publish: async (x) => { published.push(x); return { postedTo: 4, of: 4 }; } });
  const tip = await btc.chain.tip();
  assert.equal((await byHand.anchor(d, { adopt: { txid: txidOf(hex), sinceHeight: tip } })).phase, PHASE.SENT);
  const b = btc.mine();
  const [r] = await byHand.pass();
  assert.deepEqual([r.phase, r.height, published[0].anchor.txid], [PHASE.PUBLISHED, b.height, txidOf(hex)]);
  // a txid whose transaction carries another notice's anchor never publishes
  const other = ownNotice(GATE + 40, 1);
  const wrong = createDepartureAnchors({ chain: btc.chain, confirmedTx: btc.confirmedTx, publish: async () => { throw new Error('must not publish'); } });
  const w = await wrong.anchor(other, { adopt: { txid: txidOf(hex), sinceHeight: tip } });
  assert.equal(w.phase, PHASE.SENT); assert.match(w.why, /does not read as this notice's anchor/);
});

test('#2610 an installed node pays the anchor from its own wallet as an on-chain action, once per notice even with the record lost', async () => {
  const { nodeState } = await import('../../arena-installer/src/state.js');
  const home = mkdtempSync(join(tmpdir(), 'anchor-2610-'));
  writeFileSync(join(home, 'state.json'), JSON.stringify({ network: 'testnet4', chain: { kind: 'core' } }));
  const st = nodeState(home);
  const seed = fromHex('22'.repeat(32));
  const sent = [];
  const kit = { coinsOf: async () => ({ tip: GATE + 50, coins: [{ txid: '33'.repeat(32), vout: 0, sats: 20000, height: GATE }] }),
    broadcast: async (_c, hex) => { sent.push(hex); return txidOf(hex); }, seen: async () => false };
  const d = ownNotice(GATE + 50);
  const w1 = await installerAnchorWallet({ state: st, seed, chainKit: kit });
  const a1 = createDepartureAnchors({ wallet: w1, store: memStore() });
  const r1 = await a1.anchor(d);
  assert.equal(r1.phase, PHASE.SENT);
  assert.equal(sent.length, 1);
  const tx = parseTransaction(fromHex(sent[0]));
  assert.equal(toHex(tx.outputs[0].script), toHex(departureAnchorScript(d)));
  assert.equal(tx.outputs[0].value, 0n);
  // the arena-node record lost (another store): the installer's journal answers the one done - no second transaction built
  const a2 = createDepartureAnchors({ wallet: await installerAnchorWallet({ state: st, seed, chainKit: kit }), store: memStore() });
  const r2 = await a2.anchor(d);
  assert.equal(r2.txid, r1.txid);
  assert.deepEqual([...new Set(sent.map(txidOf))], [r1.txid]);
});

test('#2610 on a running seat: POST /owner/departure-anchor is the owner\'s, anchors only this node\'s own notices, and GET /owner/leave lists the anchors', async () => {
  const { ownerSecretFromSeed, signOwnerRequest } = await import('../src/owner.js');
  const { joinedWithLock } = await import('./lock-fixture.js');
  const secret = ownerSecretFromSeed(new Uint8Array(32).fill(8));
  const ownerRec = { pubkey: toHex(schnorr.getPublicKey(secret)), claimedAtMs: 1 };
  const s = await joinedWithLock({ owner: { store: { read: () => ownerRec, write: (o) => Object.assign(ownerRec, o), writeCode: () => {} } } });
  try {
    const base = `http://127.0.0.1:${s.d.port}`;
    const node = (await (await fetch(`${base}/owner`)).json()).node;
    const req = (args, k = secret) => signOwnerRequest({ node, action: 'departure-anchor', args, secret: k, sign: (m, x) => schnorr.sign(m, x), pubkeyOf: (x) => schnorr.getPublicKey(x) });
    const post = async (body) => { const r = await fetch(`${base}/owner/departure-anchor`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
    assert.equal((await post(req({}, ownerSecretFromSeed(new Uint8Array(32).fill(9))))).status, 403, 'another key');
    const none = await post(req({}));
    assert.equal(none.status, 404); assert.match(none.body.why, /no departure notice of its own/);
    const foreign = await post(req({ departure: departureHex(ownNotice(GATE + 60)), post: true }));
    assert.equal(foreign.status, 400); assert.match(foreign.body.why, /not signed by this node/);
    const st = await (await fetch(`${base}/owner/leave`)).json();
    assert.deepEqual(st.departureAnchors, []);
  } finally { await s.d.close(); }
});
