// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SEVEN TESTNET4 BONDS CARRIED ONTO BITCOIN ARENA (spec 0A.9, §27A.8.3): for each seat, one
// RE-AFFIRMATION of its BLWP bond for testnet4's Arena network id and one ADVERTISEMENT UPDATE naming hosted_games
// [nextblock] - the bond never spent, its maturity never restarted, no new bond. Rehearsed first on regtest
// (reaffirm-regtest.mjs, rehearse209.mjs, rehearse209b.mjs: carried bonds counted by the Arena census, unspent at their
// funding heights).
//
// Per seat this reads the node's key from its store READ-ONLY (the store is the seat's; nothing is written to it), finds its
// confirmed unspent bond on chain by that key (bondsOf: the BLWP marker, layout and advert id), and builds the two
// transactions. PAID FROM ONE NAMED INPUT: one funding transaction spends exactly ARENA_FUND_INPUT (txid:vout) of the bond
// wallet - never a bond, never a marker - into fourteen carrier outputs; each re-affirmation and each update spends its own
// carrier. The carrier keys are written (0600) before anything is broadcast, so a funded carrier is never stranded.
//
// Without --publish it builds everything, checks every transaction with testmempoolaccept, reads each back as the census
// reads it, and broadcasts nothing.
//
//   ARENA_FUND_INPUT=<txid>:<vout> node tools/testnet4-reaffirm.mjs [--publish] [--update-only]
//
// THE ADVERTISEMENT CARRIED IS THE BOND'S NEWEST OF THE BLWP ERA (measured 2026-10-09): the BLWP updates of
// 154282 named each node's guardian of federation 337ae01a; step 4's updates (155609) were built from the bond's FIRST
// advertisement (154172), whose guardian_of[] names keys the federation does not have - so under series ab069055's census
// 0 of its 7 guardians were bonded and every seat refused every paid round (409, §23.6). The BLWP updates pay the BLWP
// marker and carry the "BLW" 'A' payload, which the Arena reader does not look for; they are read here by the ancestor's
// layout, id and payload. --update-only: the bonds are re-affirmed already (155609) - one update each, no re-affirmation.
// ARENA_FEDERATION_READ_DIR (+ ARENA_STAKE_LOCK_BIN): every update must name, for the federation, only guardian keys its
// config has, and at least its threshold of them - read from the federation before anything is built.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { regtest } from './regtest-bond.mjs';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { NETWORK_ID_TESTNET4 } from '../../arena-protocol/src/genesis-ids.js';
import { readAdvertUpdate, checkAgainstBond } from '../../arena-protocol/src/advert-update.js';
import { readReaffirmationPayload, reaffirmationMessage } from '../../arena-protocol/src/reaffirm.js';
import { parseTransaction, commitmentsOf } from '../../arena-protocol/src/tx.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { ancestorMarker, ancestorAdvertId, decodeAncestorAdvert } from '../../arena-protocol/src/ancestor.js';
import { splitSignedAdvert } from '../../arena-protocol/src/advert.js';
import { witnessRunsOf } from '../../arena-protocol/src/tx.js';

const env = process.env;
// THE GAMES EACH SEAT HOSTS (2026-10-10: the seven seats name Tick Tock, Rock Paper Scissors and Bitcoin Up
// or Down): ARENA_HOSTED_APPS, game ids in hex, comma-separated - written sorted, as an advertisement lists them; unset,
// nextblock's alone (as the updates). A seat serves a game's rounds only if its advert in the round's census names it.
const HOSTED = (env.ARENA_HOSTED_APPS ? env.ARENA_HOSTED_APPS.split(',').map((x) => fromHex(x.trim())) : [NEXTBLOCK.gameId])
  .sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y)));
if (!HOSTED.every((g) => g.length === 32) || new Set(HOSTED.map(toHex)).size !== HOSTED.length) throw new Error('ARENA_HOSTED_APPS: 32-byte game ids, each once');
const publish = process.argv.includes('--publish');
const updateOnly = process.argv.includes('--update-only');
const home = env.ARENA_TESTNET4_DIR || `${env.HOME}/blwp-testnet4`;
const datadir = env.ARENA_TN4_DATADIR || '/mnt/bitcoin/tn4';
const wallet = env.ARENA_TN4_BOND_WALLET || 'blwp-tn4-bonds';
const cli = (...a) => execFileSync(env.BITCOIN_CLI || '/mnt/bitcoin/bitcoin-31.1/bin/bitcoin-cli',
  [`-datadir=${datadir}`, `-rpcwallet=${wallet}`, ...a], { encoding: 'utf8', maxBuffer: 64 << 20 }).trim();
const say = (o) => console.log(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v instanceof Uint8Array ? toHex(v) : v)));
const CARRIER_SATS = 3000n;
const verify = (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } };

const [fundTxid, fundVout] = (env.ARENA_FUND_INPUT || '').split(':');
if (!/^[0-9a-f]{64}$/.test(fundTxid || '') || !/^\d+$/.test(fundVout || ''))
  throw new Error('ARENA_FUND_INPUT=<txid>:<vout>: the one bond-wallet output that pays for the fourteen transactions');

const rt = regtest(cli, { network: 'testnet4', wallet });
const keyOf = (n) => {
  const db = new DatabaseSync(join(home, `node-${n}.db`), { readOnly: true });
  try { const r = db.prepare('SELECT secret, pubkey FROM identity WHERE one = 0').get(); return { secret: new Uint8Array(r.secret), pubkey: new Uint8Array(r.pubkey) }; }
  finally { db.close(); }
};

// THE BOND'S NEWEST BLWP UPDATE: the BLWP marker's unspent dust at or above the bond, its "BLW" 'A' payload naming this
// bond, the signed body in its witness under the BLWP advert id, signed by the node key; the highest such wins.
const BLWP_UPDATE_MAGIC = '424c5741';
let ancestorMarkers = null;
function newestAncestorUpdateOf(bond, nodePubkey) {
  if (!ancestorMarkers) {
    const scan = JSON.parse(cli('scantxoutset', 'start', JSON.stringify([`raw(5120${toHex(ancestorMarker('testnet4'))})`])));
    ancestorMarkers = (scan.unspents || []).filter((m) => m.height > 0);
  }
  const bondTxid = toHex(fromHex(bond.txid).reverse());
  let best = null;
  for (const m of ancestorMarkers) {
    if (m.height < bond.height) continue;
    let tx;
    try { tx = parseTransaction(fromHex(cli('getrawtransaction', m.txid, 'false', cli('getblockhash', String(m.height))))); } catch { continue; }
    const payloads = commitmentsOf(tx).filter((c) => c.length === 72 && toHex(c.subarray(0, 4)) === BLWP_UPDATE_MAGIC);
    if (payloads.length !== 1) continue;
    const p = payloads[0];
    if (toHex(p.subarray(4, 36)) !== bondTxid || new DataView(p.buffer, p.byteOffset).getUint32(36, true) !== bond.vout) continue;
    const id = p.subarray(40, 72);
    for (const item of witnessRunsOf(tx)) {
      try {
        const { body, signature } = splitSignedAdvert(item);
        if (toHex(ancestorAdvertId(body)) !== toHex(id)) continue;
        const advert = decodeAncestorAdvert(body);
        if (toHex(advert.nodePubkey) !== toHex(nodePubkey) || !verify(signature, id, nodePubkey)) continue;
        if (!best || m.height > best.height) best = { advert, height: m.height, txid: m.txid };
        break;
      } catch { /* not a signed body */ }
    }
  }
  return best;
}

// THE FEDERATION'S GUARDIANS, when its client directory is named: what every update's guardian_of[] is checked against
let federation = null;
if (env.ARENA_FEDERATION_READ_DIR) {
  const j = JSON.parse(execFileSync(env.ARENA_STAKE_LOCK_BIN || `${home}/patched/bin/blwp-stake-lock`,
    ['--mode', 'guardians', '--data-dir', env.ARENA_FEDERATION_READ_DIR], { encoding: 'utf8', timeout: 120000 }).trim().split('\n').pop());
  federation = { id: String(j.federation_id), threshold: Number(j.threshold), keys: new Set((j.keys || []).map((k) => String(k.key))) };
  say({ federation: federation.id.slice(0, 16), guardians: federation.keys.size, threshold: federation.threshold });
}
const guardiansOk = (advert) => {
  if (!federation) return { ok: true };
  const named = (advert.guardianOf || []).filter((g) => toHex(g.federationId) === federation.id).map((g) => toHex(g.guardianKey));
  const unknown = named.filter((k) => !federation.keys.has(k));
  if (unknown.length) return { ok: false, why: `names guardian key(s) the federation does not have: ${unknown.map((k) => k.slice(0, 8)).join(', ')}` };
  return { ok: true, keys: named };
};

const plans = [];
for (let n = 1; n <= 7; n++) {
  const { secret, pubkey } = keyOf(n);
  const bonds = rt.bondsOf(secret);
  if (!bonds.length) throw new Error(`node ${n} (${toHex(pubkey).slice(0, 8)}) has no confirmed unspent bond: nothing to carry, and no bond is posted`);
  const bond = bonds[0];
  say({ node: n, nodeKey: toHex(pubkey).slice(0, 16), bond: `${bond.txid}:${bond.vout}`, bondHeight: bond.height, sats: bond.sats,
    ancestor: !!bond.ancestor, otherBonds: bonds.slice(1).map((b) => `${b.txid}:${b.vout}`), endpoint: bond.advert.endpoint,
    guardianOf: (bond.advert.guardianOf || []).length, hostsNow: (bond.advert.hostedGames || []).map((g) => toHex(g).slice(0, 8)) });
  if (!bond.ancestor) throw new Error(`node ${n}: its bond is not the BLWP network's - nothing to re-affirm (already Arena's?)`);
  const blwp = newestAncestorUpdateOf(bond, pubkey);
  const base = blwp ? blwp.advert : bond.bondAdvert;
  const advert = { ...base, hostedGames: HOSTED, timestamp: BigInt(Date.now()) };
  const g = guardiansOk(advert);
  if (!g.ok) throw new Error(`node ${n}: the update ${g.why}`);
  say({ node: n, carries: blwp ? `BLWP update ${blwp.txid.slice(0, 16)} at ${blwp.height}` : `bond advertisement at ${bond.height}`,
    arenaNow: bond.updatedBy ? `${bond.updatedBy.txid.slice(0, 16)} at ${bond.updatedBy.height}` : null,
    guardianOf: (advert.guardianOf || []).map((x) => `${toHex(x.federationId).slice(0, 8)}:${toHex(x.guardianKey).slice(0, 8)}`) });
  plans.push({ n, secret, pubkey, bond, advert,
    reaffirm: updateOnly ? null : rt.prepareReaffirmation(secret, bond, { networkId: NETWORK_ID_TESTNET4 }),
    update: rt.prepareAdvertUpdate(secret, advert) });
}
if (federation) {
  const covered = new Set(plans.flatMap((p) => guardiansOk(p.advert).keys));
  if (covered.size < federation.threshold) throw new Error(`the updates name ${covered.size} of the federation's guardians, below its threshold ${federation.threshold}`);
  say({ guardiansNamed: covered.size, threshold: federation.threshold });
}

// THE CARRIER KEYS, WRITTEN FIRST
const keysPath = join(home, `reaffirm-carriers-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}.json`);
writeFileSync(keysPath, JSON.stringify(plans.flatMap((p) => [
  ...(p.reaffirm ? [{ node: p.n, kind: 'reaffirmation', bond: `${p.bond.txid}:${p.bond.vout}`, carrierSecret: toHex(p.reaffirm.carrierSecret), carrierSpk: toHex(p.reaffirm.spk) }] : []),
  { node: p.n, kind: 'update', bond: `${p.bond.txid}:${p.bond.vout}`, carrierSecret: toHex(p.update.carrierSecret), carrierSpk: toHex(p.update.spk) },
]), null, 2) + '\n', { mode: 0o600 });

// ONE FUNDING TRANSACTION FROM THE NAMED INPUT ONLY
const input = JSON.parse(cli('gettxout', fundTxid, fundVout, 'true') || 'null');
if (!input) throw new Error(`${fundTxid}:${fundVout} is not an unspent output`);
const inputSats = Math.round(input.value * 1e8);
if (plans.some((p) => p.bond.txid === fundTxid)) throw new Error('that input is in a bond transaction; it is not spent here');
if (inputSats <= 1000) throw new Error('that input has a marker\'s value; it is not spent here');
const spks = plans.flatMap((p) => (p.reaffirm ? [p.reaffirm.spk, p.update.spk] : [p.update.spk]));
const outputs = spks.map((spk) => ({ [JSON.parse(cli('decodescript', toHex(spk))).address]: Number(CARRIER_SATS) / 1e8 }));
const funded = JSON.parse(cli('-named', 'walletcreatefundedpsbt', `inputs=${JSON.stringify([{ txid: fundTxid, vout: Number(fundVout) }])}`,
  `outputs=${JSON.stringify(outputs)}`, `options=${JSON.stringify({ add_inputs: false, include_unsafe: true, fee_rate: 2 })}`));
const signed = JSON.parse(cli('walletprocesspsbt', funded.psbt));
const final = JSON.parse(cli('finalizepsbt', signed.psbt));
if (!final.complete) throw new Error('the funding transaction did not sign');
const fundingHex = final.hex;
const fundingTx = JSON.parse(cli('decoderawtransaction', fundingHex));
if (fundingTx.vin.length !== 1 || fundingTx.vin[0].txid !== fundTxid || fundingTx.vin[0].vout !== Number(fundVout))
  throw new Error('the funding transaction spends something other than the named input');
const utxo = (spk) => ({ txid: fundingTx.txid, vout: fundingTx.vout.find((o) => o.scriptPubKey.hex === toHex(spk)).n, value: CARRIER_SATS });

const built = [];
for (const p of plans) {
  const r = p.reaffirm ? rt.postReaffirmation(p.reaffirm, { utxo: utxo(p.reaffirm.spk) }) : null;
  const u = rt.postAdvertUpdate(p.update, { txid: p.bond.txid, vout: p.bond.vout }, { utxo: utxo(p.update.spk) });
  for (const [what, hex] of [...(r ? [['re-affirmation', r.hex]] : []), ['update', u.hex]]) {
    const d = JSON.parse(cli('decoderawtransaction', hex));
    // NO BOND IS SPENT OR POSTED: one input, its carrier; no output of a bond's size
    if (d.vin.length !== 1 || d.vin[0].txid !== fundingTx.txid) throw new Error(`node ${p.n}: the ${what} spends something other than its carrier`);
    if (d.vout.some((o) => Math.round(o.value * 1e8) >= 10000)) throw new Error(`node ${p.n}: the ${what} carries a bond-sized output`);
  }
  // READ BACK AS THE CENSUS READS THEM, before anything is broadcast
  const rp = r ? commitmentsOf(parseTransaction(fromHex(r.hex))).map(readReaffirmationPayload).find(Boolean) : null;
  const bondTxid = fromHex(p.bond.txid).reverse();
  const rOk = !r || !!rp && toHex(rp.networkPrefix) === toHex(NETWORK_ID_TESTNET4.subarray(0, 8))
    && verify(rp.signature, reaffirmationMessage({ networkId: NETWORK_ID_TESTNET4, bondTxid, bondVout: p.bond.vout }), p.pubkey);
  if (!rOk) throw new Error(`node ${p.n}: the re-affirmation does not read back for testnet4's Arena id under its node key`);
  const read = readAdvertUpdate(fromHex(u.hex), { network: 'testnet4' });
  const checked = read.ok ? await checkAgainstBond(read, { txid: bondTxid, vout: p.bond.vout, nodePubkey: p.pubkey }, verify) : read;
  if (!checked.ok) throw new Error(`node ${p.n}: the update does not read back: ${checked.why}`);
  if (checked.advert.hostedGames.map(toHex).join(',') !== HOSTED.map(toHex).join(',')) throw new Error(`node ${p.n}: the update hosts other games than ${HOSTED.map((g) => toHex(g).slice(0, 8)).join(', ')}`);
  const gr = guardiansOk(checked.advert);
  if (!gr.ok || (federation && !gr.keys.length)) throw new Error(`node ${p.n}: the update as read back ${gr.why || 'names none of the federation\'s guardians'}`);
  built.push({ n: p.n, bond: `${p.bond.txid}:${p.bond.vout}`, reaffirmation: r, update: u });
}
const accept = JSON.parse(cli('testmempoolaccept', JSON.stringify([fundingHex, ...built.flatMap((b) => (b.reaffirmation ? [b.reaffirmation.hex, b.update.hex] : [b.update.hex]))])));
say({ funding: fundingTx.txid, fundingFee: funded.fee, inputSats, carriers: spks.length, carrierKeys: keysPath, network: toHex(NETWORK_ID_TESTNET4).slice(0, 16),
  accept: accept.map((a) => ({ txid: a.txid.slice(0, 16), allowed: a.allowed, why: a['reject-reason'] || null })) });
if (!accept.every((a) => a.allowed)) throw new Error('the mempool refuses a transaction above; nothing is broadcast');
for (const b of built) say({ node: b.n, bond: b.bond, reaffirmation: b.reaffirmation ? b.reaffirmation.txid : null, update: b.update.txid });
if (!publish) { say({ published: false, why: 'no --publish: built and checked, nothing broadcast' }); process.exit(0); }
cli('sendrawtransaction', fundingHex);
for (const b of built) { if (b.reaffirmation) cli('sendrawtransaction', b.reaffirmation.hex); cli('sendrawtransaction', b.update.hex); }
say({ published: true, funding: fundingTx.txid, reaffirmations: built.filter((b) => b.reaffirmation).map((b) => b.reaffirmation.txid), updates: built.map((b) => b.update.txid) });
process.exit(0);
