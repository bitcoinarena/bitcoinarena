// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 state machine audit, node lifecycle (sm1-find-node, wf1489-sm1-node-4): A DEPARTURE ANCHOR THAT CONFIRMED BEFORE THE SEAT RECORDED IT
// IS NEVER FOUND. An installed node pays its departure anchor from its own wallet as an on-chain action (departure-anchor.js installerAnchorWallet,
// onchain-action.js, `once` per notice). The seat's anchor record (<db>.departure-anchors.json) is written only after that action answered. A seat
// that stops between the broadcast and that write (an update stops it, a crash, a kill) - or whose open action another process of the wallet
// finished (the custody agent resumes open actions) - comes back to an action already DONE: the wallet answers the same bytes, and the record is
// written NOW with sinceHeight = tip - 1. The installer wallet has no where(), so locate() scans the chain only FORWARD from sinceHeight: the
// block that mined the anchor while the seat was away lies below it and is never read. The record stays SENT for good (each pass broadcasts it
// again: "already in utxo set"), the notice is never published with its anchor, and past the gate (#2608) the guardian's departure never counts.
// Invariant: an anchor transaction confirmed on this node's chain is found, and its notice published with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { DEPARTURE_ANCHOR_HEIGHT, DEPARTURE_ANCHOR_SLACK } from '../../arena-protocol/src/absence.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { ownDeparture } from '../src/absence-producer.js';
import { createDepartureAnchors, installerAnchorWallet, PHASE } from '../src/departure-anchor.js';

const FED = new Uint8Array(32).fill(0x27);
const keys = Array.from({ length: 4 }, (_, i) => { const secret = new Uint8Array(32).fill(i + 41); return { secret, pub: schnorr.getPublicKey(secret) }; });
const peerOf = (i) => Uint8Array.from([2, ...new Uint8Array(32).fill(0x70 + i)]);
const NOTICE = 432;
const GATE = DEPARTURE_ANCHOR_HEIGHT.testnet4;
const ownNotice = (tip, i = 0) => ownDeparture({ own: { federation: toHex(FED), peerKey: peerOf(i) }, tip, departureNotice: NOTICE, nodePubkey: keys[i].pub,
  sign: (m) => schnorr.sign(m, keys[i].secret), slack: DEPARTURE_ANCHOR_SLACK });

// the #2610 test's fake bitcoind (wf1489-2610-1.test.js)
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

test('wf1489-sm1-node-4: an installed node\'s departure anchor mined while the seat was down is found and published after its restart', async () => {
  const { nodeState } = await import('../../arena-installer/src/state.js');
  const home = mkdtempSync(join(tmpdir(), 'wf1489-sm1-node-4-'));
  writeFileSync(join(home, 'state.json'), JSON.stringify({ network: 'testnet4', chain: { kind: 'core' } }));
  const st = nodeState(home);
  const seed = fromHex('22'.repeat(32));
  const btc = fakeBitcoind({ tip: GATE + 50 });
  // the installer's chain kit on the same bitcoind: its mempool and its blocks
  const kit = { coinsOf: async () => ({ tip: await btc.chain.tip(), coins: [{ txid: '33'.repeat(32), vout: 0, sats: 20000, height: GATE }] }),
    broadcast: async (_c, hex) => btc.cli('sendrawtransaction', hex), seen: async () => false };
  const d = ownNotice(GATE + 50);
  // THE SEAT STOPS RIGHT AFTER THE BROADCAST: the wallet's action is DONE, the seat's record never reached its file
  const dying = { read: () => null, write: () => { throw new Error('killed (the update stopped the seat)'); } };
  const a1 = createDepartureAnchors({ wallet: await installerAnchorWallet({ state: st, seed, chainKit: kit }), chain: btc.chain, confirmedTx: btc.confirmedTx, store: dying });
  await assert.rejects(a1.anchor(d), /killed/);
  assert.equal(btc.mempool.size, 1, 'the anchor is in the mempool');
  // while the seat is down (an update: download, backup, start - minutes) the anchor confirms, and blocks follow
  const blk = btc.mine(); btc.mine(); btc.mine();
  assert.equal(blk.txids.length, 1);
  // THE RESTARTED SEAT: the minute's pass asks again; the wallet answers the one done, the record is written now
  const published = [];
  let file = null;
  const store = { read: () => (file ? JSON.parse(file) : null), write: (v) => { file = JSON.stringify(v); } };
  const a2 = createDepartureAnchors({ wallet: await installerAnchorWallet({ state: st, seed, chainKit: kit }), chain: btc.chain, confirmedTx: btc.confirmedTx, store,
    publish: async (x) => { published.push(x); return { postedTo: 3, of: 3 }; } });
  const r = await a2.anchor(d);
  assert.equal(r.txid, blk.txids[0], 'the same transaction (no second anchor)');
  for (let i = 0; i < 5; i++) { await a2.pass(); btc.mine(); }
  const [last] = await a2.pass();
  assert.equal(last.phase, PHASE.PUBLISHED, `the anchor confirmed at ${blk.height} is found and its notice published - the record is ${last.phase}, `
    + `scanning from ${JSON.parse(file).anchors[last.id].sinceHeight}${last.why ? ` (${last.why})` : ''}`);
  assert.equal(published.length, 1);
  assert.deepEqual(published[0].anchor, { txid: blk.txids[0], blockHash: blk.hash });
});
