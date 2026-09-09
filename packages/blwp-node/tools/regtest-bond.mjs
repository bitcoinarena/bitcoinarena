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
  if (height() < 101) mine(101 - height());

  // A BLOCK WITH THESE TRANSACTIONS IN IT. The funding spend carries the
  // advertisement body as a witness item, which consensus allows and mempool
  // policy does not ("bad-witness-nonstandard"). 5A.2 requires the body to
  // travel in the witness, so `generateblock` is what measures consensus
  // without asking the mempool.
  const include = (hexes) => cli('generateblock', cli('getnewaddress'), JSON.stringify(hexes));

  const carrierScript = (key) => Uint8Array.from([0x75, 0x20, ...key, 0xac]);
  function carrierFor(secret) {
    const key = schnorr.getPublicKey(secret);
    const script = carrierScript(key);
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
    mine(1);
    const decoded = JSON.parse(cli('gettransaction', txid, 'true', 'true')).decoded;
    const vout = decoded.vout.find((o) => o.scriptPubKey.hex === toHex(spk)).n;
    return { txid, vout, value: BigInt(Math.round(Number(btc) * 1e8)) };
  }

  const payTo = () => fromHex(JSON.parse(cli('getaddressinfo', cli('getnewaddress'))).scriptPubKey);

  /**
   * One bond for one node's own key: the bond output 5A.3B builds, the
   * network's marker, the commitment, and the signed body in the witness.
   */
  function postBond(nodeSecret, { endpoint, roles = ['game', 'verify', 'settlement'],
    bondSats = 50000000n } = {}) {
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
      payoutPubkey: new Uint8Array(32).fill(3), timestamp: 1788700000000n,
    };
    const id = advertId(advert);
    const body = joinSignedAdvert(encodeAdvert(advert), schnorr.sign(id, nodeSecret));

    const carrierSecret = schnorr.utils.randomSecretKey();
    const carrier = carrierFor(carrierSecret);
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
      witnesses: [scriptPathWitness({
        stack: [schnorr.sign(sighash, carrierSecret), body],
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

  return { height, mine, include, postBond, blocksFrom, genesis: g };
}
