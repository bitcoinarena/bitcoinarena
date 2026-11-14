// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
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
import { ancestorAdvertId, decodeAncestorAdvert } from '../../arena-protocol/src/ancestor.js';
import { reaffirmationMessage, reaffirmationPayload } from '../../arena-protocol/src/reaffirm.js';
import { execFileSync } from 'node:child_process';
import { schnorr } from '@noble/curves/secp256k1.js';
import { genesisFor } from '../../arena-protocol/src/genesis.js';
import { signBondPresig } from '../../arena-protocol/src/slash-presig.js';
import {
  bondOutputKey, bondInternalKey, tapLeafHash, TAPLEAF_VERSION, bondMaturityOf, maturityHeightFor, BOND_TEMPLATE_V2, BOND_TEMPLATE_V3, bond3OutputKey,
  recoveryLeaf, controlBlockFor,
} from '../../arena-protocol/src/bond-script.js';
import { tapSighash, scriptPathWitness, serializeSpend } from '../../arena-protocol/src/bond-spend.js';
import { encodeAdvert, advertId, joinSignedAdvert, splitSignedAdvert, decodeAdvert } from '../../arena-protocol/src/advert.js';
import { parseTransaction, commitmentsOf, witnessRunsOf } from '../../arena-protocol/src/tx.js';
import { splitBlock } from '../../arena-protocol/src/block.js';
import { bondMarker } from '../../arena-protocol/src/constants.js';
import { advertUpdatePayload, readAdvertUpdate } from '../../arena-protocol/src/advert-update.js';
import { toHex, fromHex, taggedHash } from '../../arena-protocol/src/hash.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { tweakPoint, combine } from '../src/curve.js';

/** Everything a caller needs against one running regtest. */
/** A regtest owner secret for a node secret (kanban #1093): the owner key of a tool's template-3 bond, held by the tool, never the node key. */
export function regtestOwnerSecret(nodeSecret) {
  return taggedHash('ARENA/regtest/OwnerSecret', Uint8Array.from(nodeSecret));
}

export function regtest(cli, { wallet = 'arena', network = 'regtest', scan = null } = {}) {
  const g = genesisFor(network);

  if (!JSON.parse(cli('listwallets')).includes(wallet)) {
    try { cli('loadwallet', wallet); } catch { cli('createwallet', wallet); }
  }
  // ONE UTXO SCAN AT A TIME, WAITED FOR (measured 2026-10-13: two runners started on one bitcoind at once - the
  // Up/Down keeper beside the Tick Tock keeper, on the test host and on the test host - and the second died on "Scan already in
  // progress", error -8): a scan another process runs is waited out, 2 s at a time, up to 4 min, then asked again
  // `scan` IN PLACE OF THIS WAIT (kanban #741): a caller that must not wait - a seat's own advert check - answers the scans itself
  const scanUtxos = scan || ((descriptors) => {
    for (let i = 0; ; i++) {
      try { return JSON.parse(cli('scantxoutset', 'start', JSON.stringify(descriptors))); }
      catch (e) {
        const said = String((e && (e.stderr || e.message)) || e);
        if (!/Scan already in progress/.test(said) || i >= 120) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
      }
    }
  });
  const height = () => Number(cli('getblockcount'));
  const mine = (n = 1) => cli('generatetoaddress', String(n), cli('getnewaddress'));
  // A CHAIN THE OPERATOR MINES IS A CHAIN THE OPERATOR GRINDS (RULED 2026-09-21 17:01).
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
  if (minable && height() < 101) mine(101 - height());

  // A BLOCK WITH THESE TRANSACTIONS IN IT. The funding spend carries the
  // advertisement body as a witness item, which consensus allows and mempool
  // policy does not ("bad-witness-nonstandard"). 5A.2 requires the body to
  // travel in the witness, so `generateblock` is what measures consensus
  // without asking the mempool.
  // ON A CHAIN THAT IS NOT OURS TO MINE (testnet4): the chunked witness is standard, so the transactions are broadcast
  // and this waits until each is in a block - somebody else's.
  const include = (hexes) => {
    if (minable) return cli('generateblock', cli('getnewaddress'), JSON.stringify(hexes));
    const ids = hexes.map((h) => cli('sendrawtransaction', h));
    for (const id of ids) waitConfirmed(id);
    return ids;
  };

  // THE BODY TRAVELS IN SEVERAL ITEMS, ONE `OP_DROP` EACH (RULED 2026-09-21).
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

  function fund(spk, btc = minable ? '1.0' : '0.001') {
    const address = JSON.parse(cli('decodescript', toHex(spk))).address;
    // ON TESTNET4 AT A NAMED FEE: its bitcoind often has no estimate ("Fee estimation failed"), and 2 sat/vB is
    // what that chain's blocks take.
    // AND FROM COINS STILL IN THE MEMPOOL (2026-09-27 17:24, the 23:00 gate): bitcoind's `send` with
    // include_unsafe spends a deposit an outside sender made that has not confirmed yet, so the deposit, the funding
    // and the bond can be mined in one block instead of each waiting on the one before.
    const txid = minable ? cli('sendtoaddress', address, btc)
      : JSON.parse(cli('-named', 'send', `outputs=${JSON.stringify({ [address]: Number(btc) })}`, 'fee_rate=2',
        `options=${JSON.stringify({ include_unsafe: true })}`)).txid;
    // Ours to mine on regtest, so it is mined. On a real chain the bond spends it from the mempool: seven funding
    // confirmations waited one after another were seven blocks (~70 min on testnet4) before the six the bonds need,
    // and the bond's own confirmation (`include`) and its depth (`bury`) are what the census reads.
    if (minable) mine(1);
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
   * `guardianOf` IS WHAT MAKES A FEDERATION ROUND OPENABLE (§23.6 P3, 2026-09-15 07:33).
   *
   * A round that takes a stake into a federation is assigned signer nodes only on a BONDED one:
   * `federationIsBonded` wants the federation's threshold of its guardian keys advertised under
   * `guardian_of[]` by distinct census nodes bonded at or above the round's `bond_min`. This posted
   * `guardianOf: []` and nothing else, so the count was zero of the threshold and every paying FEDERATION
   * round was refused "this signer node signer nodes no round on an unbonded federation" - correctly, and
   * with no way for a harness to say otherwise. Now a caller that KNOWS its federation's guardians can
   * name them, which is the only thing a local federation round was missing.
   */
  /**
   * THE NODE'S BOND ALREADY ON CHAIN (spec §5A.3; 2026-09-28 07:39: "a bond that once confirmed stays valid. The
   * operator does not post again"). Every bond a node posts pays the same output key - it is built from the node key,
   * the network's arbitration keys and its maturity, nothing else - so the chain's own UTXO set answers which of the
   * node's bonds are still unspent. Of those, the newest confirmed one whose committed advertisement says what the
   * node says now (`want`: endpoint, guardian or not, guardian endpoint, which federation keys it guards) and that
   * carries at least `bondSats`. Null when there is none, and then - only then - a bond is posted.
   */
  function findBond(nodeSecret, { endpoint, guardianOf = [], guardianCapable = false, guardianEndpoint = '', bondSats = 0n } = {}) {
    // EVERY FEDERATION ASKED FOR, AND MAYBE MORE (kanban #502, measured 2026-10-20 ~10:00Z: fed2's nodes A-F advertise, since their update
    // at 157,071, B AND its successor 4dc88be7; a runner that names B alone found "no confirmed unspent bond ... says what node(s) A, B, C,
    // D, E, F say now" and stopped): a bond whose advertisement guards every federation wanted - and others besides - says what is wanted
    const guards = (list) => new Set((list || []).map((x) => `${toHex(x.federationId)}:${toHex(x.guardianKey)}`));
    const covers = (have, want) => [...guards(want)].every((k) => guards(have).has(k));
    for (const b of bondsOf(nodeSecret)) {
      if (BigInt(b.sats) < BigInt(bondSats)) continue;
      const { advert } = b;
      if (advert.endpoint !== endpoint || !!advert.guardianCapable !== !!guardianCapable
        || (advert.guardianEndpoint || '') !== (guardianEndpoint || '') || !covers(advert.guardianOf, guardianOf)) continue;
      return b;
    }
    return null;
  }

  /**
   * EVERY CONFIRMED UNSPENT BOND OF THIS NODE KEY, newest first, each with the advertisement it stands for now: the
   * newest signed update of it (§5A.2; 2026-09-28: "accept an updated advert and select the existing bond"),
   * else the one it committed to at creation (`bondAdvert` is always the latter).
   */
  function bondsOf(nodeSecret) {
    // THE PUBLIC KEY IS ENOUGH (attach, 2026-09-29): `{ pubkey }` in place of the secret - finding a bond reads the chain
    // and signs nothing, so a launcher that holds no node's store can find every node's bond.
    const nodeKey = nodeSecret && nodeSecret.pubkey ? nodeSecret.pubkey : schnorr.getPublicKey(nodeSecret);
    // THE MARKERS ARE READ AGAIN EACH TIME: kept from an earlier call they missed an update posted since, and a re-bond
    // built off that record carried the advertisement from before it (measured,: hosted_games lost)
    markers = null;
    const built = keyAt(nodeKey, g.bondMaturity);
    const scan = scanUtxos([`raw(5120${toHex(built.outputKey)})`]);
    // TEMPLATE 2 PAYS A KEY OF ITS OWN HEIGHT, so no one key finds them: each bond transaction pays this
    // network's marker dust, which nobody spends, and a marker whose transaction commits to a template-2 body of this
    // node key names the bond output to ask the UTXO set about.
    const unspent = [...(scan.unspents || []), ...v2BondsOf(nodeKey)]
      .filter((u) => u.height > 0).sort((a, b) => b.height - a.height);
    const out = [];
    for (const u of unspent) {
      const tx = parseTransaction(fromHex(cli('getrawtransaction', u.txid, 'false', cli('getblockhash', String(u.height)))));
      const commitments = commitmentsOf(tx);
      let advert = null, advertSignature = null;
      let ancestor = false;
      for (const item of witnessRunsOf(tx)) {
        try {
          const signed = splitSignedAdvert(item);
          const commits = (id) => commitments.some((c) => c.length === 32 && id.every((b, i) => b === c[i]));
          // a bond of this network, or one the BLWP network posted (ancestor.js): read by its own layout and id
          let a = null;
          try { a = decodeAdvert(signed.body); if (!commits(advertId(a))) a = null; } catch { a = null; }
          if (!a && commits(ancestorAdvertId(signed.body))) { a = decodeAncestorAdvert(signed.body); ancestor = true; }
          if (a) { advert = a; advertSignature = signed.signature; break; }
        } catch { /* not a signed body */ }
      }
      if (!advert || toHex(advert.nodePubkey) !== toHex(nodeKey)) continue;
      // THE KEY ON CHAIN IS THE ONE THIS BODY'S TEMPLATE AND HEIGHT BUILD, or it is not this body's bond
      // (one found by genesis' key is that key by the scan itself; one found by the marker is checked here)
      const maturity = bondMaturityOf(advert, { genesisMaturity: g.bondMaturity });
      if (!maturity.ok) continue;
      if (u.byMarker ? toHex(keyOfAdvert(advert, maturity.maturity).outputKey) !== u.scriptPubKey.slice(4)
        : advert.bondScriptTemplateVersion !== 1) continue;
      const newer = newestUpdateOf({ txid: fromHex(u.txid).reverse(), vout: u.vout, height: u.height, nodePubkey: nodeKey, advert });
      out.push({ txid: u.txid, vout: u.vout, height: u.height, sats: Math.round(u.amount * 1e8), maturity: maturity.maturity,
        advert: newer ? newer.advert : advert, bondAdvert: advert, bondSignature: advertSignature, ...(ancestor ? { ancestor: true } : {}),
        ...(newer ? { updatedBy: { txid: newer.txidHex, height: newer.height } } : {}) });
    }
    return out;
  }

  /** The bond output key of a node at one maturity: genesis' for template 1, the bond's own for template 2. */
  function keyAt(nodeKey, bondMaturity) {
    return bondOutputKey({
      nodeKey, arbitrationKeys: g.arbitrationKeys, arbitrationK: g.arbitrationK, bondMaturity,
      internalKey: bondInternalKey({ nodeKey, arbitrationKeys: g.arbitrationKeys }, { combine }).internalKey,
    }, { tweakPoint, combine });
  }

  /** The same off a body: template 3's path B holds the census key that body names (5A.3B). */
  function keyOfAdvert(advert, bondMaturity) {
    const nodeKey = advert.nodePubkey;
    // template 3 (ruling #1103): path A is the owner key the body names, the internal key is NUMS - no arbitration keys
    return advert.bondScriptTemplateVersion === BOND_TEMPLATE_V3
      ? bond3OutputKey({ nodeKey, ownerKey: advert.ownerPubkey, censusKey: advert.censusKey, bondMaturity }, { tweakPoint }) : keyAt(nodeKey, bondMaturity);
  }

  /** This node key's unspent template-2 and template-3 bond outputs, as scantxoutset answers them, found by the marker (read fresh). */
  function v2BondsOf(nodeKey) {
    const scan = scanUtxos([`raw(5120${toHex(bondMarker(network))})`]);
    const found = [];
    const seen = new Set();
    for (const m of (scan.unspents || []).filter((x) => x.height > 0)) {
      if (seen.has(m.txid)) continue;
      seen.add(m.txid);
      let tx;
      try { tx = parseTransaction(fromHex(cli('getrawtransaction', m.txid, 'false', cli('getblockhash', String(m.height))))); }
      catch { continue; }
      const commitments = commitmentsOf(tx);
      let advert = null;
      for (const item of witnessRunsOf(tx)) {
        try {
          const a = decodeAdvert(splitSignedAdvert(item).body);
          const id = advertId(a);
          if (commitments.some((c) => c.length === 32 && id.every((b, i) => b === c[i]))) { advert = a; break; }
        } catch { /* not a signed body */ }
      }
      if (!advert || ![BOND_TEMPLATE_V2, BOND_TEMPLATE_V3].includes(advert.bondScriptTemplateVersion) || toHex(advert.nodePubkey) !== toHex(nodeKey)) continue;
      const out = JSON.parse(cli('gettxout', m.txid, String(advert.bondVout), 'false') || 'null');
      if (!out) continue;
      found.push({ txid: m.txid, vout: advert.bondVout, height: m.height, amount: out.value, scriptPubKey: out.scriptPubKey.hex, byMarker: true });
    }
    return found;
  }

  /**
   * THE NEWEST SIGNED UPDATE OF ONE BOND, off the chain's own UTXO set: an update pays the network's marker dust, which
   * nobody can spend, so every update is an unspent marker output. Each is read at its block (no txindex needed) and
   * kept only if it names this bond, carries its node key, is signed by it and sits at or above the bond.
   */
  let markers = null;
  function newestUpdateOf(bond) {
    const tsOfBody = (a) => { try { return a && a.timestamp !== undefined && a.timestamp !== null ? BigInt(a.timestamp) : null; } catch { return null; } };
    const ownTs = tsOfBody(bond.advert);
    if (!markers) {
      const scan = scanUtxos([`raw(5120${toHex(bondMarker(network))})`]);
      markers = (scan.unspents || []).filter((m) => m.height > 0);
    }
    let best = null;
    for (const m of markers) {
      if (m.height < bond.height) continue;
      let read;
      try { read = readAdvertUpdate(fromHex(cli('getrawtransaction', m.txid, 'false', cli('getblockhash', String(m.height)))), { network }); }
      catch { continue; }
      if (!read.ok || toHex(read.bondTxid) !== toHex(bond.txid) || read.bondVout !== bond.vout) continue;
      if (toHex(read.nodePubkey) !== toHex(bond.nodePubkey)) continue;
      let signed = false;
      try { signed = schnorr.verify(read.signature, read.advertId, read.nodePubkey); } catch { signed = false; }
      if (!signed) continue;
      // ONLY A NEWER BODY IS AN UPDATE (kanban #2426, advert-update.js newestUpdates): a body the node signed before - the bond's own, an
      // old check, an old step-out - re-posted by anyone is not newer than what it copies. The update in force is the one with the highest
      // signed timestamp above the bond's own body; of equal ones the first mined, as the census counts only a strictly newer one.
      const ts = tsOfBody(read.advert);
      if (ts === null || (ownTs !== null && ts <= ownTs)) continue;
      if (best && (ts < best.ts || (ts === best.ts && m.height >= best.height))) continue;
      best = { advert: read.advert, height: m.height, txidHex: m.txid, ts };
    }
    if (best) delete best.ts;
    return best;
  }

  /**
   * AN ADVERTISEMENT UPDATE FOR ONE EXISTING BOND (§5A.2): the marker dust, OP_RETURN "ARN" 'A' bond outpoint
   * H(advertisement), the body signed by the node key in the witness - funded like a bond's carrier, spending no bond
   * and starting no maturity clock. `bond` is { txid (hex as bitcoind shows it), vout }. `prepareAdvertUpdate` signs the
   * body and names the carrier output to fund; `postAdvertUpdate` spends that carrier (from `utxo` when the caller
   * funded it with coins it chose, else funded here) and answers the raw transaction.
   */
  function prepareAdvertUpdate(nodeSecret, advert, { carrierSecret = schnorr.utils.randomSecretKey() } = {}) {
    const nodeKey = schnorr.getPublicKey(nodeSecret);
    if (toHex(advert.nodePubkey) !== toHex(nodeKey)) throw new Error('an update names the node key that signs it');
    const id = advertId(advert);
    const pieces = chunksOf(joinSignedAdvert(encodeAdvert(advert), schnorr.sign(id, nodeSecret)));
    const carrier = carrierFor(carrierSecret, pieces.length);
    return { id, pieces, carrierSecret, carrier, spk: carrier.spk };
  }

  function postAdvertUpdate(prepared, bond, { utxo, fundBtc = minable ? '0.001' : '0.00003', feeSats = 1200n } = {}) {
    const { id, pieces, carrierSecret, carrier } = prepared;
    const funded = utxo || fund(carrier.spk, fundBtc);
    const payload = advertUpdatePayload({ bondTxid: fromHex(bond.txid).reverse(), bondVout: bond.vout, advertIdBytes: id });
    const outputs = [
      { value: 330n, script: fromHex('5120' + toHex(bondMarker(network))) },
      { value: 0n, script: Uint8Array.from([0x6a, payload.length, ...payload]) },
    ];
    const change = funded.value - 330n - feeSats;
    if (change >= 546n) outputs.push({ value: change, script: payTo() });
    const inputs = [{ txid: fromHex(funded.txid).reverse(), vout: funded.vout, sequence: 0xfffffffe }];
    const sighash = tapSighash({ version: 2, locktime: 0, inputs, outputs,
      prevouts: [{ value: funded.value, script: carrier.spk }], inputIndex: 0, leafHash: carrier.leaf });
    const hex = toHex(serializeSpend({ version: 2, locktime: 0, inputs, outputs,
      witnesses: [scriptPathWitness({ stack: [schnorr.sign(sighash, carrierSecret), ...pieces],
        script: carrier.script, controlBlock: carrier.control })] }));
    return { hex, advertId: toHex(id), txid: JSON.parse(cli('decoderawtransaction', hex)).txid };
  }

  /**
   * A RE-AFFIRMATION OF ONE BOND FOR `networkId` (§27A.8.3, spec 0A.9): this network's marker dust (findable
   * as an update is) and OP_RETURN "ARN" 'F' network_id[0:8] with the bond's node key's signature over this network and
   * this bond (reaffirm.js). Spends a carrier funded like an update's - never the bond, which keeps its maturity - and
   * answers the raw transaction; the caller broadcasts it. `bond` is { txid (hex as bitcoind shows it), vout }.
   */
  function prepareReaffirmation(nodeSecret, bond, { networkId }) {
    const bondTxid = fromHex(bond.txid).reverse();
    const signature = schnorr.sign(reaffirmationMessage({ networkId, bondTxid, bondVout: bond.vout }), nodeSecret);
    const carrierSecret = schnorr.utils.randomSecretKey();
    const carrier = carrierFor(carrierSecret, 0);
    return { payload: reaffirmationPayload({ networkId, signature }), carrierSecret, carrier, spk: carrier.spk };
  }

  function postReaffirmation(prepared, { utxo, fundBtc = minable ? '0.001' : '0.00003', feeSats = 1000n } = {}) {
    const { payload, carrierSecret, carrier } = prepared;
    const funded = utxo || fund(carrier.spk, fundBtc);
    const outputs = [
      { value: 330n, script: fromHex('5120' + toHex(bondMarker(network))) },
      // 76 bytes: past a direct push, so OP_PUSHDATA1 and its length
      { value: 0n, script: Uint8Array.from([0x6a, 0x4c, payload.length, ...payload]) },
    ];
    const change = funded.value - 330n - feeSats;
    if (change >= 546n) outputs.push({ value: change, script: payTo() });
    const inputs = [{ txid: fromHex(funded.txid).reverse(), vout: funded.vout, sequence: 0xfffffffe }];
    const sighash = tapSighash({ version: 2, locktime: 0, inputs, outputs,
      prevouts: [{ value: funded.value, script: carrier.spk }], inputIndex: 0, leafHash: carrier.leaf });
    const hex = toHex(serializeSpend({ version: 2, locktime: 0, inputs, outputs,
      witnesses: [scriptPathWitness({ stack: [schnorr.sign(sighash, carrierSecret)], script: carrier.script, controlBlock: carrier.control })] }));
    return { hex, txid: JSON.parse(cli('decoderawtransaction', hex)).txid };
  }

  /**
   * A TEMPLATE-1 BOND MOVED INTO TEMPLATE 2 (2026-10-11: "spend path A into a v2 bond and publish
   * the new advert, only after a testmempoolaccept dry run"). One transaction: input 0 is the old bond by its recovery
   * leaf - its node's own key at its own maturity, which template 1 put at genesis' fixed height and is long past - and
   * input 1 a carrier whose witness holds the new signed body; output 0 is the new bond at the same value, at a maturity
   * of the next block + slack + this network's offset, then the marker dust, the commitment and the carrier's change.
   * The fee is the carrier's, so the bond keeps every sat (the round's floor is the bond). `bond` is a `bondsOf` record;
   * `advert` the body to post (bondTxid zero: "the transaction carrying me", template 2 and its height are set here).
   */
  function prepareRebond(nodeSecret, bond, advert, { slackBlocks = 6 } = {}) {
    const nodeKey = schnorr.getPublicKey(nodeSecret);
    if (toHex(advert.nodePubkey) !== toHex(nodeKey)) throw new Error('a re-bond names the node key that signs it');
    if (!Number.isInteger(bond.maturity)) throw new Error('that bond record names no maturity: read it with bondsOf');
    const maturity = maturityHeightFor(height(), network, { slackBlocks });
    const body = { ...advert, bondTxid: new Uint8Array(32), bondVout: 0, bondScriptTemplateVersion: BOND_TEMPLATE_V2, bondMaturityHeight: maturity };
    const id = advertId(body);
    const pieces = chunksOf(joinSignedAdvert(encodeAdvert(body), schnorr.sign(id, nodeSecret)));
    const carrierSecret = schnorr.utils.randomSecretKey();
    const carrier = carrierFor(carrierSecret, pieces.length);
    return { nodeSecret, nodeKey, bond, advert: body, id, pieces, maturity, built: keyAt(nodeKey, maturity),
      old: keyAt(nodeKey, bond.maturity), carrierSecret, carrier, spk: carrier.spk };
  }

  function postRebond(prepared, { utxo, fundBtc = minable ? '0.001' : '0.00003', feeSats = 1500n, locktime } = {}) {
    const { nodeSecret, nodeKey, bond, id, pieces, carrierSecret, carrier, built, old } = prepared;
    const funded = utxo || fund(carrier.spk, fundBtc);
    const bondSats = BigInt(bond.sats);
    const oldSpk = fromHex('5120' + toHex(old.outputKey));
    const outputs = [
      { value: bondSats, script: fromHex('5120' + toHex(built.outputKey)) },
      { value: 330n, script: fromHex('5120' + toHex(bondMarker(network))) },
      { value: 0n, script: Uint8Array.from([0x6a, 0x20, ...id]) },
    ];
    const change = funded.value - 330n - feeSats;
    if (change < 0n) throw new Error(`the carrier holds ${funded.value} sats, short of the marker and a ${feeSats}-sat fee`);
    if (change >= 546n) outputs.push({ value: change, script: payTo() });
    // THE LOCKTIME IS THE TIP: at or above the old leaf's CLTV (it is past), and final in the next block
    const lock = locktime ?? height();
    if (lock < bond.maturity) throw new Error(`the old bond matures at ${bond.maturity}; the tip ${lock} is before it`);
    const inputs = [
      { txid: fromHex(bond.txid).reverse(), vout: bond.vout, sequence: 0xfffffffe },
      { txid: fromHex(funded.txid).reverse(), vout: funded.vout, sequence: 0xfffffffe },
    ];
    const prevouts = [{ value: bondSats, script: oldSpk }, { value: funded.value, script: carrier.spk }];
    const tx = { version: 2, locktime: lock, inputs, outputs };
    const recovery = recoveryLeaf(nodeKey, bond.maturity);
    const sigA = schnorr.sign(tapSighash({ ...tx, prevouts, inputIndex: 0, leafHash: tapLeafHash(recovery) }), nodeSecret);
    const sigC = schnorr.sign(tapSighash({ ...tx, prevouts, inputIndex: 1, leafHash: carrier.leaf }), carrierSecret);
    const hex = toHex(serializeSpend({ ...tx, witnesses: [
      scriptPathWitness({ stack: [sigA], script: recovery, controlBlock: controlBlockFor('recovery', old).controlBlock }),
      scriptPathWitness({ stack: [sigC, ...pieces], script: carrier.script, controlBlock: carrier.control }),
    ] }));
    return { hex, advertId: toHex(id), maturity: prepared.maturity, bondSats, txid: JSON.parse(cli('decoderawtransaction', hex)).txid };
  }

  // `hostedGames`: the games the node's advertisement hosts (§0A.4) - sorted 32-byte ids; nextblock's unless given.
  /**
   * A TEMPLATE-3 BOND'S slash_presig AT BONDING (5A.3B, RULED 2026-11-02, kanban #1053): the update that makes the bond count, posted beside it, since its txid is what the signature names.
   * `posted` is postBond's answer. The hold output has no release leaf: its script is built from the bond, its advertisement and its census key alone. Answers postAdvertUpdate's.
   * `presigCarrier(advert)` names the carrier before the bond exists, so one funding transaction pays both (a bond wallet could not fund the second until the first is sent): only the
   * body's length decides the carrier, and a presig is 65 bytes whatever it signs. Hand it back as `options.carrier`.
   */
  function presigCarrier(advert) {
    const carrierSecret = schnorr.utils.randomSecretKey();
    const size = chunksOf(joinSignedAdvert(encodeAdvert({ ...advert, slashPresig: new Uint8Array(65) }), new Uint8Array(64))).length;
    return { carrierSecret, spk: carrierFor(carrierSecret, size).spk };
  }

  function postBondPresig(nodeSecret, posted, { carrier = null, ...options } = {}) {
    const bond = { txid: fromHex(posted.txid).reverse(), vout: 0, value: posted.bondSats, script: fromHex('5120' + toHex(posted.built.outputKey)) };
    const slashPresig = signBondPresig({ bond, advert: posted.advert, network, tweakPoint, sign: (d) => schnorr.sign(d, nodeSecret) });
    const prepared = prepareAdvertUpdate(nodeSecret, { ...posted.advert, slashPresig, timestamp: BigInt(Date.now()) }, carrier ? { carrierSecret: carrier.carrierSecret } : {});
    return postAdvertUpdate(prepared, { txid: posted.txid, vout: 0 }, options);
  }

  // Measured: with none named every bond this posted was refused by the advertisement's own encoder.
  function postBond(nodeSecret, { endpoint, roles = ['game', 'verify', 'settlement'],
    bondSats = 50000000n, guardianOf = [], guardianCapable = false, guardianEndpoint = '', fundBtc, hostedGames = [NEXTBLOCK_GAME_ID],
    template = BOND_TEMPLATE_V2, operatorId = '2of2', protocolVersions = [1], advert: givenAdvert = null, utxo: givenUtxo = null, slackBlocks = 6, censusKey = null, ownerSecret: givenOwnerSecret = null } = {}) {
    const nodeKey = schnorr.getPublicKey(nodeSecret);
    // A TEMPLATE-3 BOND HAS AN OWNER KEY (kanban #1093 part 1, ruling #1103): path A and the hold's return are the owner's, never the
    // node key's. A regtest tool holds the owner secret itself: `ownerSecret`, or one derived from the node secret (returned as `ownerSecret`).
    const ownerSecret = template === BOND_TEMPLATE_V3 ? (givenOwnerSecret || regtestOwnerSecret(nodeSecret)) : null;
    const ownerKey = ownerSecret ? schnorr.getPublicKey(ownerSecret) : null;
    // A NEW BOND IS TEMPLATE 2: its maturity is the next block, a few of slack and this network's offset
    // - the census counts it once it confirms no later than that slack allows. `template: 1` posts genesis' fixed height.
    // `slackBlocks` (kanban #495, 2026-10-20: the n495 bonds and their first re-bonds confirmed past their slack - 23 and 3 blocks
    // short of confirmation + 144 - and never counted): how many blocks the bond may wait for a miner
    // `template: 3` names `censusKey`, the census key the bond's path B needs beside the node key (5A.3B).
    const dated = template === BOND_TEMPLATE_V2 || template === BOND_TEMPLATE_V3;
    const maturity = dated ? maturityHeightFor(height(), network, { slackBlocks }) : g.bondMaturity;
    const built = template === BOND_TEMPLATE_V3 ? keyOfAdvert({ nodePubkey: nodeKey, bondScriptTemplateVersion: template, censusKey, ownerPubkey: ownerKey }, maturity) : keyAt(nodeKey, maturity);

    // ADD TO BOND (kanban #544): `advert` - a node's own newest advertisement (bondsOf) - posted as this bond's body, with the
    // new bond's template, height and timestamp: a second output beside the node's first, saying what the node says now.
    // `utxo` - a carrier output funded already (not broadcast yet, for a testmempoolaccept dry run) - in place of `fund`.
    if (givenAdvert && toHex(givenAdvert.nodePubkey) !== toHex(nodeKey)) throw new Error('an added bond names the node key that signs it');
    const advert = givenAdvert ? { ...givenAdvert, slashPresig: undefined, bondTxid: new Uint8Array(32), bondVout: 0, bondScriptTemplateVersion: template,
      ...(dated ? { bondMaturityHeight: maturity } : {}), ...(censusKey ? { censusKey } : {}), ...(ownerKey ? { ownerPubkey: ownerKey } : { ownerPubkey: undefined }), timestamp: BigInt(Date.now()) } : {
      // the operator and the protocol versions it speaks: '2of2' and [1] unless the caller names them (a node of
      // its own operator, drawable beside the 14 '2of2' nodes; it speaks what its build speaks)
      nodePubkey: nodeKey, operatorId, protocolVersions, roles, hostedGames,
      endpoint, region: 'eu-west', capacityClass: 1,
      softwareHash: new Uint8Array(32).fill(2),
      settlementCapabilities: 0, lightningCapabilities: 0,
      bondTxid: new Uint8Array(32), bondVout: 0, bondScriptTemplateVersion: template,
      ...(dated ? { bondMaturityHeight: maturity } : {}), ...(censusKey ? { censusKey } : {}), ...(ownerKey ? { ownerPubkey: ownerKey } : {}),
      payoutPubkey: new Uint8Array(32).fill(3), guardianOf,
      // NOT A GUARDIAN unless the caller passes what the node answered (§5A.1 v4.6.4)
      guardianCapable, guardianEndpoint, timestamp: 1788700000000n,
    };
    const id = advertId(advert);
    const body = joinSignedAdvert(encodeAdvert(advert), schnorr.sign(id, nodeSecret));

    const carrierSecret = schnorr.utils.randomSecretKey();
    const pieces = chunksOf(body);
    const carrier = carrierFor(carrierSecret, pieces.length);
    const utxo = givenUtxo ? (typeof givenUtxo === 'function' ? givenUtxo(carrier.spk) : givenUtxo) : fundBtc ? fund(carrier.spk, fundBtc) : fund(carrier.spk);
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
    return { nodeKey, advert, hex, bondSats, maturity, built, carrierSecret, utxo, ...(ownerSecret ? { ownerSecret, ownerKey } : {}),
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

  return { regtestOwnerSecret, height, mine, bury, minable, waitForHeight, include, postBond, findBond, bondsOf, keyAt, keyOfAdvert, carrierFor, chunksOf, fund, payTo, prepareAdvertUpdate, postAdvertUpdate, presigCarrier, postBondPresig,
    prepareReaffirmation, postReaffirmation, prepareRebond, postRebond, newestUpdateOf, blocksFrom, genesis: g };
}
