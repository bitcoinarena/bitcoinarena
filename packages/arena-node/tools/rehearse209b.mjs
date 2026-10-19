// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE MIGRATION ON THE SEVEN-SEAT STACK (kanban #209 step 2, the two scenarios step 2's first rehearsal did not cover):
// run by rehearse209b-after.sh, which phase0's own stack harness (tn4-tools-regtest.sh) sources after its six readings -
// the BLWP world is up: seven phase0 seats with their guardians, their BLWP bonds, a BLWP paid round with a stake locked.
//
//   node tools/rehearse209b.mjs carry   - every seat's bond (found by its node key: phase0's store, read-only) re-affirmed
//                                         for this network and its advertisement updated (hosted_games nextblock and the
//                                         market) by this tree; each Arena seat's own store made, holding the same key
//   node tools/rehearse209b.mjs read    - both seat sets side by side: the phase0 seats' round and settlement, the Arena seats'
//                                         series and rounds, the census this tree derives, the bonds (unspent, at their
//                                         funding heights), the player's money
//
// Env: SEAT_DIR (phase0's node-<i>.db), ARENA_DIR (the Arena seats' stores), BITCOIN_CLI, BITCOIN_CLI_ARGS, WALLET,
// PHASE0_PORTS, ARENA_PORTS, ROUND (the BLWP round), FROM (the first height the census reads).
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { regtest } from './regtest-bond.mjs';
import { openStore, nodeIdentity } from '../src/store.js';
import { bondSetFor } from '../src/curve.js';
import { deriveCensus } from '../../arena-protocol/src/census.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { MARKET } from '../test/plugins/market/index.js';

const env = process.env;
const mode = process.argv[2];
const say = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }, (k, v) => (typeof v === 'bigint' ? String(v) : v instanceof Uint8Array ? toHex(v) : v)));
const cli = (...a) => execFileSync(env.BITCOIN_CLI, [...env.BITCOIN_CLI_ARGS.split(/[ ,]/).filter(Boolean), ...a], { encoding: 'utf8', maxBuffer: 64 << 20 }).trim();
const rt = regtest(cli, { network: 'regtest', wallet: env.WALLET || 'tn4rt' });
const seats = [1, 2, 3, 4, 5, 6, 7];
// A PHASE0 SEAT'S KEY, read-only: its store stays the running seat's, untouched
const phase0Key = (i) => {
  const db = new DatabaseSync(`${env.SEAT_DIR}/node-${i}.db`, { readOnly: true });
  try { const r = db.prepare('SELECT secret, pubkey FROM identity WHERE one = 0').get(); return { secret: new Uint8Array(r.secret), pubkey: new Uint8Array(r.pubkey) }; }
  finally { db.close(); }
};
const HOSTED = [NEXTBLOCK.gameId, MARKET.registration.gameId].sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y)));
const unspent = (txid, vout) => { const o = cli('gettxout', txid, String(vout)); return o ? JSON.parse(o).value : null; };

if (mode === 'carry') {
  const out = [];
  const hexes = [];
  for (const i of seats) {
    const key = phase0Key(i);
    const bonds = rt.bondsOf(key.secret);
    const bond = bonds[0];
    if (!bond) throw new Error(`seat ${i}: no bond of its key on this chain`);
    const r = rt.postReaffirmation(rt.prepareReaffirmation(key.secret, bond, { networkId: NETWORK_ID_REGTEST }));
    const u = rt.postAdvertUpdate(rt.prepareAdvertUpdate(key.secret, { ...bond.advert, hostedGames: HOSTED, timestamp: BigInt(Date.now()) }), bond);
    hexes.push(r.hex, u.hex);
    // THE ARENA SEAT'S OWN STORE, holding the same node key - never the phase0 seat's store
    mkdirSync(env.ARENA_DIR, { recursive: true });
    const db = openStore(`${env.ARENA_DIR}/node-${i}.db`);
    db.prepare('INSERT OR REPLACE INTO identity (one, secret, pubkey) VALUES (0, ?, ?)').run(key.secret, key.pubkey);
    const held = nodeIdentity(db);
    if (db.close) db.close();
    out.push({ seat: i, bond: `${bond.txid.slice(0, 16)}:${bond.vout}`, fundedAt: bond.height, ancestor: !!bond.ancestor, reaffirmation: r.txid.slice(0, 16),
      update: u.txid.slice(0, 16), arenaKeySame: toHex(held.pubkey) === toHex(key.pubkey) });
  }
  for (const h of hexes) cli('sendrawtransaction', h);
  rt.mine(1);
  say({ step: 'carry', at: rt.height(), seats: out });
} else if (mode === 'read') {
  const get = async (port, path) => { try { const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(20000) }); return { status: r.status, body: await r.text() }; } catch (e) { return { status: 0, body: e.message }; } };
  const P0 = env.PHASE0_PORTS.split(',').map(Number), AR = env.ARENA_PORTS.split(',').map(Number);
  const side = [];
  for (const [n, i] of seats.entries()) {
    const [id0, idA, ser, rounds] = await Promise.all([get(P0[n], '/identity'), get(AR[n], '/identity'), get(AR[n], '/series'), get(AR[n], '/rounds?ahead=120h')]);
    let listed = null; try { listed = JSON.parse(rounds.body).rounds.length; } catch { listed = rounds.body.slice(0, 80); }
    let held = null; try { held = (JSON.parse(ser.body).series || []).map((s) => (s.id || s.seriesId || '').slice(0, 16)); } catch { held = ser.body.slice(0, 80); }
    side.push({ seat: i, phase0: id0.status, arena: idA.status, sameKey: id0.status === 200 && Buffer.from(id0.body, 'latin1').length > 0 ? 'see below' : null, series: held, arenaRounds: listed });
  }
  // THE CENSUS THIS TREE DERIVES FROM THE CHAIN, as the Arena seats do (roster.js): the seven re-affirmed, updated bonds
  const tip = rt.height(), from = Number(env.FROM);
  const view = rt.blocksFrom(from, tip);
  const byTxid = new Map(); for (const b of view.blocks) for (const raw of b.transactions) { try { byTxid.set(toHex((await import('../../arena-protocol/src/tx.js')).parseTransaction(raw).txid), raw); } catch { /* */ } }
  const census = deriveCensus(view, { contract: { bondMinSats: 50000n, protocolVersion: 1, networkId: NETWORK_ID_REGTEST, censusHeight: tip, censusConfirmations: 1, gameId: NEXTBLOCK.gameId },
    bond: bondSetFor('regtest'), resolve: (e) => { const raw = byTxid.get(toHex(e.txid)); return raw ? { transaction: raw } : null; },
    verifyUpdate: (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } } });
  const bonds = seats.map((i) => { const b = rt.bondsOf(phase0Key(i).secret)[0]; return { seat: i, fundedAt: b.height, btc: unspent(b.txid, b.vout), ancestor: !!b.ancestor }; });
  say({ step: 'side by side', tip, seats: side,
    census: { ok: census.ok, why: census.why, counted: (census.entries || []).length, reaffirmed: (census.entries || []).filter((e) => e.reaffirmedBy).length,
      hostNextblock: (census.entries || []).filter((e) => (e.hostedGames || []).some((g) => toHex(g) === toHex(NEXTBLOCK.gameId))).length,
      excluded: (census.excluded || []).map((e) => `${e.step}: ${e.why}`).slice(0, 5) },
    bonds });
} else throw new Error('rehearse209b.mjs carry | read');
process.exit(0);
