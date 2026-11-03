#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CENSUS FROM THE SEAT'S INDEX, ON A REAL REGTEST (kanban #925 part 2 step 3). Posts real bonds (the advertisement in the witness,
// as census-regtest.mjs does), an advertisement update, a slash spend of one bond, and then reorganises the chain under the update; at
// each step it derives the census at several heights both ways - from whole blocks read off bitcoind (chain-rpc.js blocksOver, the
// path a seat takes without the index) and from the index's proven partial view (arena-index.js syncArenaIndex + viewOf, the path
// with ARENA_ARENA_INDEX=1) - through roster.js censusOfView, main.js's own derivation, and prints both roots. Any difference exits 1.
//
//   bitcoind -regtest -datadir=DIR -port=29544 -rpcport=29543 -fallbackfee=0.0001 -daemon
//   RT=DIR RPCPORT=29543 node tools/arena-index-regtest.mjs           (from packages/arena-node)
//
// It creates its own wallet and touches no other datadir.
import { execFileSync } from 'node:child_process';
import { schnorr } from '@noble/curves/secp256k1.js';
import { genesisFor } from '../../arena-protocol/src/genesis.js';
import { bondOutputKey, bondInternalKey, slashLeaf, tapLeafHash, controlBlockFor, TAPLEAF_VERSION } from '../../arena-protocol/src/bond-script.js';
import { tapSighash, scriptPathWitness, serializeSpend, commitmentOutput } from '../../arena-protocol/src/bond-spend.js';
import { encodeAdvert, advertId, joinSignedAdvert } from '../../arena-protocol/src/advert.js';
import { advertUpdatePayload } from '../../arena-protocol/src/advert-update.js';
import { censusFirstBlock } from '../../arena-protocol/src/census.js';
import { bondMarker, PROTOCOL_VERSION } from '../../arena-protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { toHex, fromHex, taggedHash } from '../../arena-protocol/src/hash.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { bitcoindRpc, blocksOver } from '../src/chain-rpc.js';
import { openArenaIndex, syncArenaIndex } from '../src/arena-index.js';
import { censusOfView, censusEvidenceOf } from '../src/roster.js';
import { tweakPoint, combine } from '../src/curve.js';

const RT = process.env.RT;
if (!RT) { console.error('RT=<datadir> is required'); process.exit(2); }
const B = process.env.BITCOIN_CLI || '/mnt/bitcoin/bitcoin-31.1/bin/bitcoin-cli';
const PORT = process.env.RPCPORT || '29543';
const cli = (...a) => execFileSync(B, ['-regtest', `-datadir=${RT}`, `-rpcport=${PORT}`, ...a], { encoding: 'utf8' }).trim();
const call = bitcoindRpc({ url: `http://127.0.0.1:${PORT}`, cookiePath: `${RT}/regtest/.cookie` });

const g = genesisFor('regtest');
const signerNodes = new Map();
for (let i = 0; i < g.arbitrationM; i++) {
  const secret = taggedHash('BLWP/v1/TestArbitration', new TextEncoder().encode(`bitcoin-regtest:${i}`));
  signerNodes.set(toHex(schnorr.getPublicKey(secret)), secret);
}
if (!JSON.parse(cli('listwallets')).includes('index925')) { try { cli('loadwallet', 'index925'); } catch { cli('createwallet', 'index925'); } }
if (Number(cli('getblockcount')) < 101) cli('generatetoaddress', '101', cli('getnewaddress'));
// EVERY BLOCK NAMES ITS TRANSACTIONS (generateblock): after the reorganisation the update and the slash are back in the mempool, and a
// block mined from the mempool would put them on the new branch too
const include = (txs) => cli('generateblock', cli('getnewaddress'), JSON.stringify(txs));
const mine = (n = 1) => { for (let i = 0; i < n; i++) include([]); };
const height = () => Number(cli('getblockcount'));
const payTo = fromHex(JSON.parse(cli('getaddressinfo', cli('getnewaddress'))).scriptPubKey);

// THE CARRIER (census-regtest.mjs): a taproot output whose one leaf drops what it is handed, so the signed body rides in the witness
const carrierFor = (secret) => {
  const key = schnorr.getPublicKey(secret);
  const script = Uint8Array.from([0x75, 0x20, ...key, 0xac]);
  const leaf = tapLeafHash(script);
  const { outputKey, parity } = tweakPoint(key, taggedHash('TapTweak', new Uint8Array([...key, ...leaf])));
  return { key, script, leaf, spk: fromHex('5120' + toHex(outputKey)), control: Uint8Array.from([TAPLEAF_VERSION | parity, ...key]) };
};
const fund = (spk) => {
  const txid = cli('sendtoaddress', JSON.parse(cli('decodescript', toHex(spk))).address, '1.0');
  include([txid]);
  const decoded = JSON.parse(cli('gettransaction', txid, 'true', 'true')).decoded;
  return { txid, vout: decoded.vout.find((o) => o.scriptPubKey.hex === toHex(spk)).n, value: 100000000n };
};
/** A transaction spending a fresh carrier with `outputs` (change added), the body the leaf drops in its witness. */
const carried = (outputs, body) => {
  const secret = schnorr.utils.randomSecretKey(), carrier = carrierFor(secret), utxo = fund(carrier.spk);
  const spent = outputs.reduce((n, o) => n + o.value, 0n);
  const outs = [...outputs, { value: utxo.value - spent - 3000n, script: payTo }];
  const inputs = [{ txid: fromHex(utxo.txid).reverse(), vout: utxo.vout, sequence: 0xfffffffe }];
  const sighash = tapSighash({ version: 2, locktime: 0, inputs, outputs: outs, prevouts: [{ value: utxo.value, script: carrier.spk }], inputIndex: 0, leafHash: carrier.leaf });
  const hex = toHex(serializeSpend({ version: 2, locktime: 0, inputs, outputs: outs,
    witnesses: [scriptPathWitness({ stack: [schnorr.sign(sighash, secret), body], script: carrier.script, controlBlock: carrier.control })] }));
  return { hex, txid: JSON.parse(cli('decoderawtransaction', hex)).txid };
};
const advertFor = (nodeKey, endpoint) => ({
  nodePubkey: nodeKey, operatorId: 'operator', protocolVersions: [PROTOCOL_VERSION], hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game', 'verify', 'settlement'],
  endpoint, region: 'eu-west', capacityClass: 1, softwareHash: new Uint8Array(32).fill(2), settlementCapabilities: 0, lightningCapabilities: 0,
  bondTxid: new Uint8Array(32), bondVout: 0, bondScriptTemplateVersion: 1, payoutPubkey: new Uint8Array(32).fill(3), guardianOf: [],
  guardianCapable: false, guardianEndpoint: '', timestamp: 1788700000000n,
});
const marker = { value: 330n, script: fromHex('5120' + toHex(bondMarker('regtest'))) };
function postBond(endpoint) {
  const nodeSecret = schnorr.utils.randomSecretKey(), nodeKey = schnorr.getPublicKey(nodeSecret);
  const built = bondOutputKey({ nodeKey, arbitrationKeys: g.arbitrationKeys, arbitrationK: g.arbitrationK, bondMaturity: g.bondMaturity,
    internalKey: bondInternalKey({ nodeKey, arbitrationKeys: g.arbitrationKeys }, { combine }).internalKey }, { tweakPoint, combine });
  const advert = advertFor(nodeKey, endpoint), id = advertId(advert);
  const tx = carried([{ value: 50000000n, script: fromHex('5120' + toHex(built.outputKey)) }, marker, { value: 0n, script: Uint8Array.from([0x6a, 0x20, ...id]) }],
    joinSignedAdvert(encodeAdvert(advert), schnorr.sign(id, nodeSecret)));
  return { ...tx, nodeKey, nodeSecret, built, advert, bondSats: 50000000n };
}
function postUpdate(bond, endpoint) {
  const advert = { ...bond.advert, endpoint, timestamp: 1790000000000n }, id = advertId(advert);
  const payload = advertUpdatePayload({ bondTxid: fromHex(bond.txid).reverse(), bondVout: 0, advertIdBytes: id });
  return carried([marker, { value: 0n, script: Uint8Array.from([0x6a, payload.length, ...payload]) }], joinSignedAdvert(encodeAdvert(advert), schnorr.sign(id, bond.nodeSecret)));
}
function slash(bond) {
  const script = slashLeaf(g.arbitrationKeys, g.arbitrationK), leaf = tapLeafHash(script);
  const spk = fromHex('5120' + toHex(bond.built.outputKey));
  const inputs = [{ txid: fromHex(bond.txid).reverse(), vout: 0, sequence: 0xfffffffe }];
  const outputs = [{ value: bond.bondSats - 3000n, script: payTo }, commitmentOutput(taggedHash('ARENA/v1/SlashProof', fromHex('cd'.repeat(32))))];
  const sighash = tapSighash({ version: 2, locktime: 0, inputs, outputs, prevouts: [{ value: bond.bondSats, script: spk }], inputIndex: 0, leafHash: leaf });
  const sorted = [...g.arbitrationKeys].sort((a, b) => { for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; });
  const stack = sorted.map((k, i) => (i < g.arbitrationK ? schnorr.sign(sighash, signerNodes.get(toHex(k))) : new Uint8Array(0))).reverse();
  return { hex: toHex(serializeSpend({ version: 2, locktime: 0, inputs, outputs,
    witnesses: [scriptPathWitness({ stack, script, controlBlock: controlBlockFor('slash', bond.built).controlBlock })] })) };
}

// THE INDEX, from regtest's first block, in memory; read as a seat reads it (syncArenaIndex over this bitcoind)
const index = openArenaIndex({ network: 'regtest' });
let failed = 0;
const contractAt = (censusHeight) => ({ gameId: NEXTBLOCK_GAME_ID, bondMinSats: 50000n, protocolVersion: PROTOCOL_VERSION, censusHeight, censusConfirmations: 6, networkId: NETWORK_ID_REGTEST });
const strip = (c) => JSON.stringify({ ok: c.ok, why: c.why, root: c.root && toHex(c.root),
  entries: (c.entries || []).map((e) => [toHex(e.txid), e.vout, e.height, e.updatedBy ? [toHex(e.updatedBy.txid), e.updatedBy.height, e.updatedBy.position] : null]),
  excluded: (c.excluded || []).map((e) => `${e.step}|${toHex(e.txid)}|${e.why}`).sort() });
async function compare(label, heights) {
  const synced = await syncArenaIndex(index, call);
  const tip = height();
  for (const h of heights) {
    const from = censusFirstBlock(h, 'regtest');
    const t0 = Date.now();
    const whole = await blocksOver(call, from, tip);
    const a = censusOfView(whole, contractAt(h), { network: 'regtest' });
    const t1 = Date.now();
    const partial = index.viewOf(from, tip);
    const b = censusOfView(partial, contractAt(h), { network: 'regtest' });
    const t2 = Date.now();
    const same = strip(a) === strip(b) && JSON.stringify(censusEvidenceOf(a, whole)) === JSON.stringify(censusEvidenceOf(b, partial));
    if (!same) failed++;
    const kept = partial.blocks.reduce((n, x) => n + x.transactions.length, 0), all = whole.blocks.reduce((n, x) => n + x.transactions.length, 0);
    console.log(`${label.padEnd(14)} census ${h} (tip ${tip}${synced.rolledBackFrom !== null ? `, index rolled back from ${synced.rolledBackFrom}` : ''}): `
      + `whole ${a.ok ? toHex(a.root).slice(0, 16) : a.why} ${a.entries ? a.entries.length : '-'} entries (${all} tx, ${t1 - t0} ms) | `
      + `index ${b.ok ? toHex(b.root).slice(0, 16) : b.why} ${b.entries ? b.entries.length : '-'} entries (${kept} tx, ${t2 - t1} ms) | ${same ? 'SAME' : 'DIFFERENT'}`);
  }
}

const one = postBond('wss://one/'), two = postBond('wss://two/'), three = postBond('wss://three/');
include([one.hex, two.hex, three.hex]);
const bondedAt = height();
mine(8);
await compare('bonded', [bondedAt + 3, height()]);

const up = postUpdate(two, 'wss://two-moved/');
include([up.hex]);
const updatedAt = height();
include([slash(three).hex]);
mine(7);
await compare('updated+slash', [updatedAt, updatedAt + 1, height()]);

// A REORGANISATION UNDER THE UPDATE: the update's block and everything after it gone, a branch without them, a fourth bond in it
const forkHash = cli('getblockhash', String(updatedAt));
cli('invalidateblock', forkHash);
const four = postBond('wss://four/');
include([four.hex]);
mine(10);
await compare('after reorg', [updatedAt, updatedAt + 6, height()]);
console.log(failed ? `DIFFERENT in ${failed} census(es)` : 'every census the same both ways');
process.exit(failed ? 1 : 0);
