#!/usr/bin/env node
// THE CENSUS AGAINST REAL BLOCKS. Letter 15, slice 3.
//
// Every census measurement before this one ran on fixtures: blocks a test
// composed, spend states a test declared, depths a test chose. A fixture
// cannot lie about Bitcoin, which sounds like a virtue and is the opposite -
// it means nothing had ever asked a real node whether these rules survive
// contact with real blocks, real witnesses and a real spend.
//
// This puts four bonds on an isolated regtest, spends one, leaves one shallow,
// marks one for another network, and derives the census from the node's own
// blocks - header bytes and all - with the arbitration set and a curve
// injected. Run it against a regtest daemon of your own:
//
//   bitcoind -regtest -datadir=DIR -port=29444 -rpcport=29443 \
//            -fallbackfee=0.0001 -daemon
//   RT=DIR node tools/census-regtest.mjs        (from packages/arena-node)
//
// It creates its own wallet and touches no mainnet or testnet datadir.
//
// THE ADVERTISEMENT HAS TO RIDE IN THE WITNESS (5A.2, 25.1), which the wallet
// cannot do for us: `sendtoaddress` builds its own transaction. So each bond
// is funded from a CARRIER output - a taproot output whose one leaf is
// `OP_DROP <key> OP_CHECKSIG` - and the spend of that carrier is the funding
// transaction, with the signed body as the item the leaf drops.
import { execFileSync } from 'node:child_process';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { genesisFor } from '../../arena-protocol/src/genesis.js';
import {
  bondOutputKey, bondInternalKey, slashLeaf, tapLeafHash, controlBlockFor,
  TAPLEAF_VERSION,
} from '../../arena-protocol/src/bond-script.js';
import {
  tapSighash, scriptPathWitness, serializeSpend, commitmentOutput,
} from '../../arena-protocol/src/bond-spend.js';
import { encodeAdvert, advertId, joinSignedAdvert } from '../../arena-protocol/src/advert.js';
import { deriveCensus, resolveCensus, commitCensus } from '../../arena-protocol/src/census.js';
import { splitBlock } from '../../arena-protocol/src/block.js';
import { bondMarker } from '../../arena-protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { toHex, fromHex, taggedHash } from '../../arena-protocol/src/hash.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const RT = process.env.RT;
if (!RT) { console.error('RT=<datadir> is required'); process.exit(2); }
const B = process.env.BITCOIN_CLI || '/mnt/bitcoin/bitcoin-31.1/bin/bitcoin-cli';   // another host's bitcoin-cli by BITCOIN_CLI
const PORT = process.env.RPCPORT || '29443';
const cli = (...a) =>
  execFileSync(B, ['-regtest', `-datadir=${RT}`, `-rpcport=${PORT}`, ...a], { encoding: 'utf8' }).trim();

const big = (b) => BigInt('0x' + toHex(b));
const tweakPoint = (P, t) => {
  const Q = schnorr.utils.lift_x(big(P)).add(secp256k1.Point.BASE.multiply(big(t)));
  return { outputKey: schnorr.utils.pointToBytes(Q), parity: Number(Q.toAffine().y & 1n) };
};
const combine = (terms) => {
  let sum = null;
  for (const { key, coefficient } of terms) {
    const p = schnorr.utils.lift_x(big(key)).multiply(big(coefficient));
    sum = sum === null ? p : sum.add(p);
  }
  return schnorr.utils.pointToBytes(sum);
};

const g = genesisFor('regtest');
const SET = {
  arbitrationKeys: g.arbitrationKeys, arbitrationK: g.arbitrationK,
  bondMaturity: g.bondMaturity, tweakPoint, combine,
};
const signerNodes = new Map();
for (let i = 0; i < g.arbitrationM; i++) {
  const secret = taggedHash('BLWP/v1/TestArbitration', new TextEncoder().encode(`bitcoin-regtest:${i}`));
  signerNodes.set(toHex(schnorr.getPublicKey(secret)), secret);
}

// The wallet is this script's own, and a rerun finds it already there: a
// fresh datadir needs `createwallet`, a second run needs `loadwallet`, and a
// run in the same session needs neither.
if (!JSON.parse(cli('listwallets')).includes('census15')) {
  try { cli('loadwallet', 'census15'); } catch { cli('createwallet', 'census15'); }
}
if (Number(cli('getblockcount')) < 101) cli('generatetoaddress', '101', cli('getnewaddress'));
const mine = (n = 1) => cli('generatetoaddress', String(n), cli('getnewaddress'));
// A BLOCK WITH THESE TRANSACTIONS IN IT. The funding spend carries the
// advertisement body as a witness item, which Bitcoin's CONSENSUS rules allow
// and its mempool POLICY does not ("bad-witness-nonstandard"): a tapscript
// stack item that large is not relayed. 5A.2 requires the body to travel in
// the witness, so what is measured here is what consensus says - `generateblock`
// validates the transaction fully and puts it in a block without asking the
// mempool. A real deployment would use a witness the mempool also relays; that
// is a construction question for the letter that posts a bond for real.
const include = (hexes) => cli('generateblock', cli('getnewaddress'), JSON.stringify(hexes));
const height = () => Number(cli('getblockcount'));

// ---- the carrier: one leaf that drops whatever is handed to it
const carrierScript = (key) => Uint8Array.from([0x75, 0x20, ...key, 0xac]);   // OP_DROP <32> CHECKSIG
function carrierFor(secret) {
  const key = schnorr.getPublicKey(secret);
  const script = carrierScript(key);
  const leaf = tapLeafHash(script);
  const tweak = taggedHash('TapTweak', new Uint8Array([...key, ...leaf]));
  const { outputKey, parity } = tweakPoint(key, tweak);
  return {
    key, script, leaf, outputKey,
    spk: fromHex('5120' + toHex(outputKey)),
    control: Uint8Array.from([TAPLEAF_VERSION | parity, ...key]),
  };
}

function fund(spk, btc = '1.0') {
  const address = JSON.parse(cli('decodescript', toHex(spk))).address;
  const txid = cli('sendtoaddress', address, btc);
  mine(1);
  const decoded = JSON.parse(cli('gettransaction', txid, 'true', 'true')).decoded;
  const vout = decoded.vout.find((o) => o.scriptPubKey.hex === toHex(spk)).n;
  return { txid, vout, value: BigInt(Math.round(Number(btc) * 1e8)) };
}

const payTo = fromHex(JSON.parse(cli('getaddressinfo', cli('getnewaddress'))).scriptPubKey);

const advertFor = (nodeKey, endpoint, guardian = {}) => ({
  nodePubkey: nodeKey, operatorId: 'operator', protocolVersions: [1], hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game'],
  endpoint, region: 'eu-west', capacityClass: 1, softwareHash: new Uint8Array(32).fill(2),
  settlementCapabilities: 0, lightningCapabilities: 0,
  bondTxid: new Uint8Array(32), bondVout: 0, bondScriptTemplateVersion: 1,
  payoutPubkey: new Uint8Array(32).fill(3), guardianOf: [],
  // WHETHER THIS NODE IS A GUARDIAN (§5A.1 v4.6.4): not, unless the bond below says so
  guardianCapable: guardian.guardianCapable || false, guardianEndpoint: guardian.guardianEndpoint || '',
  timestamp: 1788700000000n,
});

/**
 * A REAL BOND FUNDING TRANSACTION: the bond output, the round's marker, the
 * commitment, and the signed body in the witness of the carrier it spends.
 */
function postBond(nodeSecret, { network = 'regtest', endpoint = 'ws://node', guardian = {} } = {}) {
  const nodeKey = schnorr.getPublicKey(nodeSecret);
  const built = bondOutputKey({
    nodeKey, arbitrationKeys: g.arbitrationKeys, arbitrationK: g.arbitrationK,
    bondMaturity: g.bondMaturity,
    internalKey: bondInternalKey({ nodeKey, arbitrationKeys: g.arbitrationKeys }, { combine }).internalKey,
  }, { tweakPoint, combine });

  const advert = advertFor(nodeKey, endpoint, guardian);
  const id = advertId(advert);
  const body = joinSignedAdvert(encodeAdvert(advert), schnorr.sign(id, nodeSecret));

  const carrierSecret = schnorr.utils.randomSecretKey();
  const carrier = carrierFor(carrierSecret);
  const utxo = fund(carrier.spk);

  const bondSats = 50000000n;
  const outputs = [
    { value: bondSats, script: fromHex('5120' + toHex(built.outputKey)) },
    { value: 330n, script: fromHex('5120' + toHex(bondMarker(network))) },
    { value: 0n, script: Uint8Array.from([0x6a, 0x20, ...id]) },
    { value: utxo.value - bondSats - 330n - 3000n, script: payTo },
  ];
  const inputs = [{ txid: fromHex(utxo.txid).reverse(), vout: utxo.vout, sequence: 0xfffffffe }];
  const sighash = tapSighash({
    version: 2, locktime: 0, inputs, outputs,
    prevouts: [{ value: utxo.value, script: carrier.spk }], inputIndex: 0, leafHash: carrier.leaf,
  });
  const hex = toHex(serializeSpend({
    version: 2, locktime: 0, inputs, outputs,
    witnesses: [scriptPathWitness({
      stack: [schnorr.sign(sighash, carrierSecret), body],
      script: carrier.script, controlBlock: carrier.control,
    })],
  }));
  return { nodeKey, nodeSecret, built, hex, vout: 0, bondSats, advert, id,
           txid: JSON.parse(cli('decoderawtransaction', hex)).txid };
}

/** A slash: five of the seven signer nodes, committing to the proof that justified it. */
function slash(bond) {
  const script = slashLeaf(g.arbitrationKeys, g.arbitrationK);
  const leaf = tapLeafHash(script);
  const spk = fromHex('5120' + toHex(bond.built.outputKey));
  const inputs = [{ txid: fromHex(bond.txid).reverse(), vout: bond.vout, sequence: 0xfffffffe }];
  const proofId = taggedHash('ARENA/v1/SlashProof', fromHex('cd'.repeat(32)));
  const outputs = [{ value: bond.bondSats - 3000n, script: payTo }, commitmentOutput(proofId)];
  const sighash = tapSighash({
    version: 2, locktime: 0, inputs, outputs,
    prevouts: [{ value: bond.bondSats, script: spk }], inputIndex: 0, leafHash: leaf,
  });
  const sorted = [...g.arbitrationKeys].sort((a, b) => {
    for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
  });
  const stack = sorted
    .map((k, i) => (i < g.arbitrationK ? schnorr.sign(sighash, signerNodes.get(toHex(k))) : new Uint8Array(0)))
    .reverse();
  const hex = toHex(serializeSpend({
    version: 2, locktime: 0, inputs, outputs,
    witnesses: [scriptPathWitness({
      stack, script, controlBlock: controlBlockFor('slash', bond.built).controlBlock,
    })],
  }));
  return { hex, txid: JSON.parse(cli('decoderawtransaction', hex)).txid };
}

// ---- FOUR BONDS ON A REAL CHAIN
// THE HONEST NODE IS A GUARDIAN (§23A.2, one node is one guardian): its bond says so, with its own endpoint; the others
// are not, so a census over these blocks shows one of each.
const honest = postBond(schnorr.utils.randomSecretKey(), { endpoint: 'ws://honest',
  guardian: { guardianCapable: true, guardianEndpoint: 'ws://honest/guardian' } });
const doomed = postBond(schnorr.utils.randomSecretKey(), { endpoint: 'ws://doomed' });
const elsewhere = postBond(schnorr.utils.randomSecretKey(), { network: 'testnet', endpoint: 'ws://elsewhere' });
include([honest.hex, doomed.hex, elsewhere.hex]);
const funded = height();
mine(6);

const shallow = postBond(schnorr.utils.randomSecretKey(), { endpoint: 'ws://shallow' });
include([shallow.hex]);
const shallowAt = height();

const slashed = slash(doomed);
include([slashed.hex]);
// THE CENSUS IS HERE, AND THE CHAIN KEEPS GOING. Five more blocks put the tip
// well past it, which is the case that separates "deep at census_height" from
// "deep by now": the shallow bond is two blocks under the census and seven
// under this tip. A census whose answer moved with the tip would count it.
const CENSUS = height();
mine(5);
const TIP = height();

// ---- THE VIEW IS THE NODE'S OWN BLOCKS
const FROM = funded - 2;
const blocks = [];
for (let h = FROM; h <= TIP; h++) {
  const { header, transactions } = splitBlock(fromHex(cli('getblock', cli('getblockhash', String(h)), '0')));
  blocks.push({ header, transactions });
}

const contract = {
  bondMinSats: 1000000n, protocolVersion: 1, networkId: NETWORK_ID_REGTEST,
  censusHeight: CENSUS, censusConfirmations: 6,
};
const byTxid = new Map([honest, doomed, shallow, elsewhere].map((b) => [b.txid, b]));
const resolve = (e) => {
  const raw = cli('getrawtransaction', toHex([...e.txid].reverse()));
  return { transaction: fromHex(raw) };
};

const out = deriveCensus({ blocks, firstHeight: FROM }, { contract, resolve, bond: SET });
const name = (key) => {
  for (const b of byTxid.values()) if (toHex(b.nodeKey) === toHex(key)) return b.advert.endpoint;
  return toHex(key).slice(0, 12);
};

console.log('# heights   funded', funded, 'shallow', shallowAt, 'census', CENSUS, 'tip', TIP);
console.log('# blocks read from the node:', blocks.length, 'first', FROM);
console.log('ok         ', out.ok, out.why || '');
console.log('eligible   ', out.entries.length, out.entries.map((e) => name(e.pubkey)).join(' '));
for (const e of out.excluded) console.log('excluded   ', name(e.pubkey), '|', e.step, '|', e.why);
console.log('root       ', out.root && toHex(out.root));
console.log('unchecked  ', JSON.stringify(out.unchecked));
console.log('scanned?   elsewhere:',
  [...out.entries, ...out.excluded].some((e) => toHex(e.pubkey) === toHex(elsewhere.nodeKey)));

// ---- AND A LIST THAT LIES ABOUT THE SAME BLOCKS
const lying = [honest, doomed, shallow].map((b) => ({
  txid: fromHex(b.txid).reverse(), vout: 0, pubkey: b.nodeKey,
  bondSats: b.bondSats, height: funded, spent: false, hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game'],
}));
const told = deriveCensus({ blocks, firstHeight: FROM }, { contract, resolve, bond: SET, candidates: lying });
console.log('# handed a list claiming all three unspent and deep:');
console.log('told       ', told.ok, 'eligible', told.entries.length,
  told.entries.map((e) => name(e.pubkey)).join(' '));
for (const e of told.excluded) console.log('told-excl  ', name(e.pubkey), '|', e.step, '|', e.why);
console.log('same root  ', out.root && told.root && toHex(out.root) === toHex(told.root));

// ---- AND WHAT BELIEVING THAT LIST WOULD HAVE GIVEN. This is the "before" of
// letter 25 measured on real blocks rather than on a fixture: with no chain
// view, RESOLVE has nothing to compare the claims against and the census is
// whatever the list said - a spent bond and a two-confirmation bond both
// counted, and a different root.
const believed = resolveCensus(lying, { contract, resolve, bond: SET });
console.log('# with no chain view, the claims stand:');
console.log('believed   ', believed.ok, 'eligible', believed.eligible.length,
  believed.eligible.map((e) => name(e.pubkey)).join(' '));

// ---- THE BLOCKS, KEPT. The suite cannot start a bitcoind, so the bytes this
// node served are written out and a test replays them.
const fs = await import('node:fs');
fs.writeFileSync(process.env.DUMP || '/dev/null', JSON.stringify({
  firstHeight: FROM, censusHeight: CENSUS, tip: TIP, funded, shallowAt,
  root: toHex(out.root),
  nodes: Object.fromEntries([['honest', honest], ['doomed', doomed],
    ['shallow', shallow], ['elsewhere', elsewhere]]
    .map(([k, b]) => [k, { pubkey: toHex(b.nodeKey), txid: b.txid, endpoint: b.advert.endpoint }])),
  blocks: blocks.map((b, i) => ({
    height: FROM + i,
    hex: toHex(fromHex(cli('getblock', cli('getblockhash', String(FROM + i)), '0'))),
  })),
}, null, 1) + '\n');
console.log('slash txid ', slashed.txid);
