// POSTING A REAL BOND ON A REAL REGTEST, as one thing two tools can use.
//
// Lifted out of `census-regtest.mjs`, which has done this since letter 15 and
// is still the file that measures the census itself. What forced the move is
// letter 32: the committee seed is a block of THE CHAIN, and the census is
// derived from blocks too, so a tool that reads its beacon from bitcoind and
// its census from a fixture is a node reasoning about two different chains -
// and the roster's "is this the block my chain names" check can never pass
// there. One chain means the bonds live where the beacon does.
//
// It is not a wallet and not a bond policy: it funds a carrier, spends it with
// the advertisement body in the witness, and hands back the raw transaction.
// The construction question - a witness the mempool would also relay - is
// still the letter that posts a bond for real, and is named in census-regtest.
import { execFileSync } from 'node:child_process';
import { schnorr } from '@noble/curves/secp256k1.js';
import { genesisFor } from '../../protocol/src/genesis.js';
import {
  bondOutputKey, bondInternalKey, tapLeafHash, TAPLEAF_VERSION,
} from '../../protocol/src/bond-script.js';
import { tapSighash, scriptPathWitness, serializeSpend } from '../../protocol/src/bond-spend.js';
import { encodeAdvert, advertId, joinSignedAdvert } from '../../protocol/src/advert.js';
import { splitBlock } from '../../protocol/src/block.js';
import { bondMarker } from '../../protocol/src/constants.js';
import { toHex, fromHex, taggedHash } from '../../protocol/src/hash.js';
import { tweakPoint, combine } from '../src/curve.js';

/** Everything a caller needs against one running regtest. */
export function regtest(cli, { wallet = 'blwp', network = 'regtest' } = {}) {
  const g = genesisFor(network);

  if (!JSON.parse(cli('listwallets')).includes(wallet)) {
    try { cli('loadwallet', wallet); } catch { cli('createwallet', wallet); }
  }
  const height = () => Number(cli('getblockcount'));
  const mine = (n = 1) => cli('generatetoaddress', String(n), cli('getnewaddress'));
  // A CHAIN THE OPERATOR MINES IS A CHAIN THE OPERATOR GRINDS (RULED, the owner 2026-09-21 17:01).
  //
  // The bonds have to be six deep at the census height, and on regtest that is `mine(6)` - instant, and
  // fine, because a free round's beacon is nobody's money. On a real chain it is not fine: the round's
  // beacon is the first block after `committee_time`, so an operator who can make blocks can make the
  // beacon he wants. So on any chain but regtest this WAITS for the six somebody else mined. Measured on
  // testnet4: 723.3 s a block over the last 144, which is about 72 minutes for six.
  const minable = network === 'regtest';
  // The waits BLOCK, like everything else in this file: a launcher standing a round up has nothing else
  // to do until its bonds are buried, and making these async would turn every caller inside out.
  const rest = (ms) => { try { execFileSync('sleep', [String(ms / 1000)]); } catch { /* interrupted */ } };
  const waitForHeight = (want, { everyMs = 15000, sayEveryMs = 120000 } = {}) => {
    let said = 0;
    for (;;) {
      const now = height();
      if (now >= want) return now;
      if (Date.now() - said > sayEveryMs) {
        said = Date.now();
        console.log(`[chain] waiting for ${network} to reach ${want}; it is at ${now}, ${want - now} to go`);
      }
      rest(everyMs);
    }
  };
  const waitConfirmed = (txid, { everyMs = 15000 } = {}) => {
    for (;;) {
      let seen = 0;
      try { seen = Number(JSON.parse(cli('gettransaction', txid)).confirmations || 0); } catch { seen = 0; }
      if (seen >= 1) return seen;
      rest(everyMs);
    }
  };
  /** Six deep, by mining when this chain is ours to mine and by waiting when it is not. */
  const bury = (n = 6) => {
    if (minable) { mine(n); return height(); }
    return waitForHeight(height() + n);
  };
  if (height() < 101) mine(101 - height());

  // A BLOCK WITH THESE TRANSACTIONS IN IT. The funding spend carries the
  // advertisement body as a witness item, which consensus allows and mempool
  // policy does not ("bad-witness-nonstandard"). 5A.2 requires the body to
  // travel in the witness, so `generateblock` is what measures consensus
  // without asking the mempool.
  const include = (hexes) => cli('generateblock', cli('getnewaddress'), JSON.stringify(hexes));

  // THE BODY TRAVELS IN SEVERAL ITEMS, ONE `OP_DROP` EACH (RULED, the owner 2026-09-21).
  //
  // Measured on this node at d14fbec7: the spend is `witness_v1_taproot` and the stack was
  // [64 sig, 266 body, 35 script, 33 control], and it was refused `bad-witness-nonstandard` - Bitcoin Core
  // holds a TAPSCRIPT witness stack item to 80 bytes just as it does a P2WSH one, so the 266-byte body was
  // the whole of the refusal. No advertisement field is cut and the signature keeps its own item: the body
  // is simply split into pieces of at most 80 bytes, and the carrier script drops one per piece.
  const CHUNK = 80;
  const chunksOf = (body) => {
    const out = [];
    for (let at = 0; at < body.length; at += CHUNK) out.push(body.subarray(at, Math.min(at + CHUNK, body.length)));
    return out;
  };
  const carrierScript = (key, drops = 1) =>
    Uint8Array.from([...new Array(drops).fill(0x75), 0x20, ...key, 0xac]);
  function carrierFor(secret, drops = 1) {
    const key = schnorr.getPublicKey(secret);
    const script = carrierScript(key, drops);
    const leaf = tapLeafHash(script);
    const tweak = taggedHash('TapTweak', new Uint8Array([...key, ...leaf]));
    const { outputKey, parity } = tweakPoint(key, tweak);
    return { key, script, leaf, outputKey,
      spk: fromHex('5120' + toHex(outputKey)),
      control: Uint8Array.from([TAPLEAF_VERSION | parity, ...key]) };
  }

  function fund(spk, btc = '1.0') {
    const address = JSON.parse(cli('decodescript', toHex(spk))).address;
    const txid = cli('sendtoaddress', address, btc);
    // The funding output needs one confirmation before it is spent. Ours to mine on regtest; on a real
    // chain it is somebody else's block and this waits for it rather than pretending.
    if (minable) mine(1);
    else waitConfirmed(txid);
    const decoded = JSON.parse(cli('gettransaction', txid, 'true', 'true')).decoded;
    const vout = decoded.vout.find((o) => o.scriptPubKey.hex === toHex(spk)).n;
    return { txid, vout, value: BigInt(Math.round(Number(btc) * 1e8)) };
  }

  const payTo = () => fromHex(JSON.parse(cli('getaddressinfo', cli('getnewaddress'))).scriptPubKey);

  /**
   * One bond for one node's own key: the bond output 5A.3B builds, the
   * network's marker, the commitment, and the signed body in the witness.
   */
  /**
   * `guardianOf` IS WHAT MAKES A FEDERATION ROUND OPENABLE (§23.6 P3, the owner 2026-09-15 07:33).
   *
   * A round that takes a stake into a federation is assigned signer nodes only on a BONDED one:
   * `federationIsBonded` wants the federation's threshold of its guardian keys advertised under
   * `guardian_of[]` by distinct census nodes bonded at or above the round's `bond_min`. This posted
   * `guardianOf: []` and nothing else, so the count was zero of the threshold and every paying FEDERATION
   * round was refused "this signer node signer nodes no round on an unbonded federation" - correctly, and
   * with no way for a harness to say otherwise. Now a caller that KNOWS its federation's guardians can
   * name them, which is the only thing a local federation round was missing.
   */
  function postBond(nodeSecret, { endpoint, roles = ['game', 'verify', 'settlement'],
    bondSats = 50000000n, guardianOf = [] } = {}) {
    const nodeKey = schnorr.getPublicKey(nodeSecret);
    const built = bondOutputKey({
      nodeKey, arbitrationKeys: g.arbitrationKeys, arbitrationK: g.arbitrationK,
      bondMaturity: g.bondMaturity,
      internalKey: bondInternalKey({ nodeKey, arbitrationKeys: g.arbitrationKeys },
        { combine }).internalKey,
    }, { tweakPoint, combine });

    const advert = {
      nodePubkey: nodeKey, operatorId: '2of2', protocolVersions: [1], roles,
      endpoint, region: 'eu-west', capacityClass: 1,
      softwareHash: new Uint8Array(32).fill(2),
      settlementCapabilities: 0, lightningCapabilities: 0,
      bondTxid: new Uint8Array(32), bondVout: 0, bondScriptTemplateVersion: 1,
      payoutPubkey: new Uint8Array(32).fill(3), guardianOf, timestamp: 1788700000000n,
    };
    const id = advertId(advert);
    const body = joinSignedAdvert(encodeAdvert(advert), schnorr.sign(id, nodeSecret));

    const carrierSecret = schnorr.utils.randomSecretKey();
    const pieces = chunksOf(body);
    const carrier = carrierFor(carrierSecret, pieces.length);
    const utxo = fund(carrier.spk);
    const outputs = [
      { value: bondSats, script: fromHex('5120' + toHex(built.outputKey)) },
      { value: 330n, script: fromHex('5120' + toHex(bondMarker(network))) },
      { value: 0n, script: Uint8Array.from([0x6a, 0x20, ...id]) },
      { value: utxo.value - bondSats - 330n - 3000n, script: payTo() },
    ];
    const inputs = [{ txid: fromHex(utxo.txid).reverse(), vout: utxo.vout, sequence: 0xfffffffe }];
    const sighash = tapSighash({
      version: 2, locktime: 0, inputs, outputs,
      prevouts: [{ value: utxo.value, script: carrier.spk }], inputIndex: 0,
      leafHash: carrier.leaf,
    });
    const hex = toHex(serializeSpend({
      version: 2, locktime: 0, inputs, outputs,
      // The stack is read bottom-up, so the signature goes in first and the pieces above it; the
      // `OP_DROP`s take the pieces off in reverse and leave the signature for `OP_CHECKSIG`.
      witnesses: [scriptPathWitness({
        stack: [schnorr.sign(sighash, carrierSecret), ...pieces],
        script: carrier.script, controlBlock: carrier.control,
      })],
    }));
    return { nodeKey, advert, hex, bondSats,
      txid: JSON.parse(cli('decoderawtransaction', hex)).txid };
  }

  /** Blocks `from`..`to` as the census reads them: header plus transactions. */
  function blocksFrom(from, to) {
    const blocks = [];
    for (let h = from; h <= to; h++) {
      const raw = fromHex(cli('getblock', cli('getblockhash', String(h)), '0'));
      const { header, transactions } = splitBlock(raw);
      blocks.push({ header, transactions });
    }
    return { blocks, firstHeight: from };
  }

  return { height, mine, bury, minable, waitForHeight, include, postBond, blocksFrom, genesis: g };
}
