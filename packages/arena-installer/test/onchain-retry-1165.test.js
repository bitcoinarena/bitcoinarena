// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// BROADCAST FIRST, RECORD AFTER (kanban #1165, the state machine audit 2026-11-06): the installer's on-chain actions sent their
// transactions and only then wrote the state, so a crash between the two - or a lost answer, or a second click - built a SECOND valid
// transaction from the mempool's change (wallet.js coinsOf counts it): a second bond, a second peg-in, a second new bond for the key move.
// Each scenario runs against a small mempool that behaves as Bitcoin Core's does (a transaction known already: "txn-already-in-mempool";
// spent inputs: "txn-mempool-conflict"), and counts what reached it. Before #1165 each one ends with two; after it, with one.
// Only the modules any installer has are imported, so this file runs against the source before #1165 too (and fails there).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { addBond } from '../src/add-bond.js';
import { createCustodyAgent } from '../src/custody-agent.js';
import { switchToSeedKey } from '../src/identity-switch.js';
import { nodeState, bondsOf } from '../src/state.js';
import { walletOf, addressScript } from '../src/wallet.js';
import { nodeKeyOf } from '../src/seed.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { advertInTransaction } from '../../arena-protocol/src/census.js';
import { inviteForGuardians } from '../../arena-node/src/invite.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const SEED = '11'.repeat(32);
const txidOf = (tx) => toHex(Uint8Array.from(tx.txid).reverse());
const outpoint = (i) => `${toHex(Uint8Array.from(i.previousTxid).reverse())}:${i.previousVout}`;

/** A mempool over a few confirmed coins of the wallet: what Bitcoin Core answers, and what it holds. `lose(tx)` true: the transaction
 *  is taken and its answer lost (the HTTP answer that never came); `hang(tx)` true: taken, and the call never returns (the process died). */
function mempool(spk, coins) {
  const confirmed = new Map(coins.map((c) => [`${c.txid}:${c.vout}`, { ...c, spkHex: toHex(spk) }]));
  const txs = new Map();   // txid -> { tx, hex }
  const spentBy = new Map();
  const outputOf = (k) => {
    if (confirmed.has(k)) return confirmed.get(k);
    const [txid, vout] = k.split(':');
    const t = txs.get(txid);
    const o = t && t.tx.outputs[Number(vout)];
    return o ? { txid, vout: Number(vout), sats: Number(o.value), spkHex: toHex(o.script), height: 0 } : null;
  };
  const kit = {
    lose: () => false, hang: () => false,
    coinsOf: async () => {
      const all = [...confirmed.values(), ...[...txs.values()].flatMap(({ tx }) => tx.outputs.map((_, v) => outputOf(`${txidOf(tx)}:${v}`)))];
      return { tip: 157070, coins: all.filter((c) => c && c.spkHex === toHex(spk) && !spentBy.has(`${c.txid}:${c.vout}`)).map(({ spkHex, ...c }) => c) };
    },
    broadcast: async (_c, hex) => {
      const tx = parseTransaction(fromHex(hex));
      const txid = txidOf(tx);
      if (txs.has(txid)) throw new Error('bitcoind: txn-already-in-mempool');
      for (const i of tx.inputs) {
        if (spentBy.has(outpoint(i))) throw new Error('bitcoind: txn-mempool-conflict');
        if (!outputOf(outpoint(i))) throw new Error('bitcoind: bad-txns-inputs-missingorspent');
      }
      for (const i of tx.inputs) spentBy.set(outpoint(i), txid);
      txs.set(txid, { tx, hex });
      if (kit.hang(tx)) return new Promise(() => {});
      if (kit.lose(tx)) throw new Error('socket hang up');
      return txid;
    },
    seen: async (_c, txid) => txs.has(txid),
    txs,
    /** the transactions in it that carry an advertisement (a bond, or an advertisement update) */
    adverts: () => [...txs.values()].filter(({ hex }) => { try { return !!advertInTransaction(fromHex(hex)); } catch { return false; } }),
    /** the payments in it to `script` */
    paymentsTo: (script) => [...txs.values()].filter(({ tx }) => tx.outputs.some((o) => toHex(o.script) === toHex(script))),
  };
  return kit;
}

function bondedNode(extra = {}) {
  const home = mkdtempSync(join(tmpdir(), 'onchain-1165-'));
  const state = nodeState(home);
  writeFileSync(join(home, 'seed.hex'), SEED);
  const random = new Uint8Array(32).fill(6);
  const db = new DatabaseSync(join(home, 'node.db'));
  db.exec('CREATE TABLE identity (one INTEGER PRIMARY KEY, secret BLOB, pubkey BLOB)'); db.prepare('INSERT INTO identity VALUES (0, ?, ?)').run(random, schnorr.getPublicKey(random)); db.close();
  state.save({ roles: ['verify', 'settlement'], chain: { kind: 'core' }, owner: { pubkey: 'ab'.repeat(32) }, reach: { mode: 'permanent', url: 'https://node.example.com' },
    bond: { txid: '77'.repeat(32), vout: 0, sats: '50000', maturity: 157057 }, ...extra });
  return { home, state, random, w: walletOf(fromHex(SEED)) };
}
const settle = () => new Promise((ok) => setTimeout(ok, 50));

test('add to bond: the process dies after the bond is broadcast and before it is recorded - the next ask sends it again, never a second output', async () => {
  const n = bondedNode();
  const chain = mempool(n.w.spk, [{ txid: '5a'.repeat(32), vout: 1, sats: 100000, height: 157000 }]);
  // the first ask: the bond reaches the mempool, then the process is gone (its call never comes back)
  chain.hang = (tx) => !!advertInTransaction(serialize(tx, chain));
  addBond({ state: n.state, addSats: 32000, post: true, chainKit: chain, censusKey: null }).catch(() => {});
  await settle();
  chain.hang = () => false;
  // the owner asks again (the page reloaded, the seat restarted)
  const r = await addBond({ state: n.state, addSats: 32000, post: true, chainKit: chain, censusKey: null }).catch((e) => ({ ok: false, why: e.message }));
  const bonds = chain.adverts().length, outputs = bondsOf(n.state.read()).length;
  console.log(`  #1165 add-bond, crash after the broadcast: ${bonds} bond transaction(s) in the mempool, ${outputs} output(s) recorded (want 1 and 2)`);
  assert.equal(bonds, 1, 'one added output reached the chain');
  assert.equal(outputs, 2, 'the first bond and the added one, recorded once');
  assert.equal(r.ok, true, r.why);
});

test('add to bond: the answer is lost, the owner clicks again - one output', async () => {
  const n = bondedNode();
  const chain = mempool(n.w.spk, [{ txid: '5a'.repeat(32), vout: 1, sats: 100000, height: 157000 }]);
  chain.lose = (tx) => !!advertInTransaction(serialize(tx, chain));
  const first = await addBond({ state: n.state, addSats: 32000, post: true, chainKit: chain, censusKey: null }).catch((e) => ({ ok: false, why: e.message }));
  chain.lose = () => false;
  const again = await addBond({ state: n.state, addSats: 32000, post: true, chainKit: chain, censusKey: null }).catch((e) => ({ ok: false, why: e.message }));
  const bonds = chain.adverts().length;
  console.log(`  #1165 add-bond, answer lost then clicked again: ${bonds} bond transaction(s), ${bondsOf(n.state.read()).length} output(s) recorded; first ${first.ok ? 'ok' : `"${first.why}"`}, again ${again.ok ? 'ok' : `"${again.why}"`}`);
  assert.equal(bonds, 1);
  assert.equal(bondsOf(n.state.read()).length, 2);
});

test('the custody agent: killed between the peg-in broadcast and its save - the next tick sends the same peg-in, never a second', async () => {
  const fid = 'ee'.repeat(32);
  const n = bondedNode({ roles: ['verify', 'custody'], custody: { pegInSats: 50000, guardianOf: { federationId: fid, txid: '88'.repeat(32) } },
    gateway: { apiUrl: 'http://127.0.0.1:8476', passwordFile: '/nowhere', federations: [{ federationId: fid }] } });
  const dir = join(n.home, 'node.db.guardian'); mkdirSync(dir);
  writeFileSync(join(dir, 'invite-code'), `"${inviteForGuardians(fromHex(fid), [{ url: 'wss://node.example.com/guardian', peer: 2 }])}"\n`);
  writeFileSync(join(dir, 'local.json'), JSON.stringify({ identity: 2 }));
  writeFileSync(join(dir, 'consensus.json'), JSON.stringify({ broadcast_public_keys: { 2: '03' + 'cd'.repeat(32) } }));
  const pegAddress = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
  const chain = mempool(n.w.spk, [{ txid: '5a'.repeat(32), vout: 1, sats: 200000, height: 157000 }]);
  const agentOf = () => createCustodyAgent({ state: n.state, release: n.home, chainKit: chain, hubs: [],
    gw: { joinFederation: async () => ({ ok: true }), testGateway: async () => ({ ok: true, federations: [{ federationId: fid }] }), depositAddress: async () => ({ ok: true, address: pegAddress }) },
    federationLoad: async () => ({ reserveSats: 0n, exposureCapSats: 1000000n, network: 'testnet4', load: 0 }),
    channels: async () => ({ ok: false }), lndInfo: async () => ({ ok: false }), ringMembers: async () => [],
    lnd: { funds: async () => ({ ok: false, why: 'no LND here' }), peers: async () => ({ ok: false }), connect: async () => ({ ok: false }), close: async () => ({ ok: false }), openTo: async () => ({ ok: false }) } });
  chain.hang = (tx) => tx.outputs.some((o) => toHex(o.script) === toHex(addressScript(pegAddress)));
  agentOf().tick().catch(() => {});
  await settle();
  chain.hang = () => false;
  const r = await agentOf().tick().catch((e) => ({ ok: false, why: e.message }));   // the service started it again
  const pegIns = chain.paymentsTo(addressScript(pegAddress)).length;
  console.log(`  #1165 custody agent, killed after the peg-in broadcast: ${pegIns} peg-in(s) in the mempool; custody.pegIn ${n.state.read().custody.pegIn ? 'recorded' : 'missing'}; the next tick: ${r.did || r.idle || r.why}`);
  assert.equal(pegIns, 1, 'one peg-in');
  assert.ok(n.state.read().custody.pegIn, 'recorded');
  assert.equal(n.state.read().custody.guardianOf.txid, '88'.repeat(32), 'custody\'s other fields kept');
});

test('the key move: the process dies after the new bond is broadcast, before the key swap - one new bond, the key swapped once, the old kept', async () => {
  const n = bondedNode();
  const chain = mempool(n.w.spk, [{ txid: '5a'.repeat(32), vout: 1, sats: 150000, height: 157000 }]);
  chain.hang = (tx) => !!advertInTransaction(serialize(tx, chain));
  switchToSeedKey({ home: n.home, release: n.home, state: n.state, chainKit: chain, post: true }).catch(() => {});
  await settle();
  chain.hang = () => false;
  const r = await switchToSeedKey({ home: n.home, release: n.home, state: n.state, chainKit: chain, post: true }).catch((e) => ({ ok: false, why: e.message }));
  const want = toHex(schnorr.getPublicKey(nodeKeyOf(fromHex(SEED))));
  const db = new DatabaseSync(join(n.home, 'node.db'));
  const key = toHex(schnorr.getPublicKey(new Uint8Array(db.prepare('SELECT secret FROM identity WHERE one = 0').get().secret)));
  let olds = []; try { olds = db.prepare('SELECT pubkey FROM identity_old').all(); } catch { olds = []; }
  db.close();
  const bonds = chain.adverts().length;
  console.log(`  #1165 key move, crash after the broadcast: ${bonds} new bond(s) in the mempool; key ${key === want ? 'the words\' key' : 'still the old one'}; ${olds.length} old key(s) kept; the state's bond ${(n.state.read().bond || {}).txid === (r.bond || {}).txid ? 'is the new one' : 'is not the new one'}`);
  assert.equal(bonds, 1, 'one new bond');
  assert.equal(key, want, 'the node signs with the words\' key');
  assert.equal(olds.length, 1, 'the old key kept once');
  assert.equal(n.state.read().oldBonds.length, 1);
  assert.equal(r.ok, true, r.why);
  assert.equal(n.state.read().bond.txid, r.bond.txid);
});

/** the bytes of a parsed transaction as the mempool holds them */
function serialize(tx, chain) { const t = chain.txs.get(txidOf(tx)); return fromHex(t.hex); }
