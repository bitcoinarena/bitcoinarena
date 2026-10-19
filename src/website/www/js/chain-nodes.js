// THE NODES, FROM BITCOIN (2026-10-09: "The overview is dynamic. It asks the nodes. The site learns the
// nodes from bond announcements, for example through mempool.space ... No static links to nodes"; §25.1: "A client finds
// nodes by reading Bitcoin").
//
// The site's Worker reads, through mempool.space, every transaction that pays one of the two testnet4 bond markers - the
// Arena marker (re-affirmations, advertisement updates, Arena bonds) and its BLWP ancestor's (the bonds the testnet4 seats
// were created with) - and hands this page the raw transactions, their merkle branches and block headers, and which bond
// outputs are spent. Nothing it says is taken on its word: each transaction is proved into its header here, each bond and
// advertisement is read out of its own bytes, and every signature is checked with the node's key. A list provider can
// omit a node but cannot invent one.
//
// A NODE IS: a bond (an Arena bond, or an ancestor bond its operator re-affirmed for testnet4), unspent, with the newest
// advertisement it signed - its own, or a later update's. The answer names its key, endpoint and hosted games.
import { parseTransaction, commitmentsOf, witnessRunsOf } from './protocol/tx.js';
import { splitSignedAdvert, decodeAdvert, advertId } from './protocol/advert.js';
import { ancestorMarker, ancestorAdvertId, decodeAncestorAdvert } from './protocol/ancestor.js';
import { bondMarker } from './protocol/constants.js';
import { provesTransaction, recognizeBond, paysMarkerProgram } from './protocol/chain.js';
import { readAdvertUpdate } from './protocol/advert-update.js';
import { readReaffirmationPayload, reaffirmationMessage } from './protocol/reaffirm.js';
import { NETWORK_ID_TESTNET4 } from './protocol/genesis-ids.js';

const fromHex = (h) => Uint8Array.from(h.match(/../g) || [], (x) => parseInt(x, 16));
const toHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const zero = (b) => b.every((x) => x === 0);
// mempool.space names txids and branch hashes in display order; the chain's own bytes are reversed
const internal = (displayHex) => fromHex(displayHex).reverse();

/** The signed body in a transaction's witness whose id one of its outputs commits to, read as `decode` reads it. */
function committedBody(tx, decode, idOf) {
  const commitments = commitmentsOf(tx).filter((c) => c.length === 32);
  for (const item of witnessRunsOf(tx)) {
    try {
      const { body, signature } = splitSignedAdvert(item);
      const advert = decode(body);
      const id = idOf(body, advert);
      if (commitments.some((c) => same(c, id))) return { advert, signature, id };
    } catch { /* not a signed body; most witness items are not */ }
  }
  return null;
}

/** The bond read out of one transaction's bytes, unchecked: { advert, signature, id, ancestor } or null. */
function bondOf(tx) {
  const ancestor = paysMarkerProgram(tx, ancestorMarker('testnet'));
  const read = ancestor ? committedBody(tx, decodeAncestorAdvert, (body) => ancestorAdvertId(body))
    : committedBody(tx, decodeAdvert, (body, a) => advertId(a));
  return read ? { ...read, ancestor } : null;
}

/** For the Worker: which output of a raw transaction (hex) is a bond, or null - so it asks mempool.space only those. */
export function bondVoutOf(hex) {
  try { const b = bondOf(parseTransaction(fromHex(hex))); return b ? b.advert.bondVout : null; } catch { return null; }
}

/**
 * `data`: the Worker's { txs: [{ txid, marker, hex, height, pos, merkle, header, outspends }] }; `verify(sig, msg, key)`:
 * BIP-340. Answers { nodes, bonds, rejected }: nodes [{ key, endpoint, base, hostedGames, bond, advertTxid, height }].
 */
export function nodesFromChain(data, { verify }) {
  const rejected = [];
  const proven = [];
  for (const t of (data && data.txs) || []) {
    let tx;
    try { tx = parseTransaction(fromHex(t.hex)); } catch (e) { rejected.push({ txid: t.txid, why: 'not a transaction: ' + e.message }); continue; }
    if (toHex([...tx.txid].reverse()) !== t.txid) { rejected.push({ txid: t.txid, why: 'the bytes are another transaction' }); continue; }
    if (!t.header || !Array.isArray(t.merkle) || !provesTransaction(fromHex(t.header), tx.txid, t.merkle.map(internal), t.pos)) {
      rejected.push({ txid: t.txid, why: 'not proved into its block' }); continue;
    }
    proven.push({ t, tx });
  }
  const sig = (s, m, k) => { try { return !zero(k) && !zero(s) && verify(s, m, k); } catch { return false; } };
  // 1. BONDS, read (an ancestor's: its marker and its committed body; or Arena's own) - their signatures are checked only for
  // the bonds that end up counting (step 3), as every signature check costs a phone a few milliseconds
  const bonds = [];
  for (const { t, tx } of proven) {
    const read = bondOf(tx);
    if (!read) continue;                                                // an update or re-affirmation, read below
    const { ancestor } = read;
    const seen = recognizeBond(tx, read.advert.bondVout, read.advert, { network: 'testnet', ...(ancestor ? { ancestor: true } : {}) });
    if (!seen.ok) { rejected.push({ txid: t.txid, why: seen.why }); continue; }
    // spent or not, as mempool.space last answered; a bond it has not answered for yet does not count
    const said = Array.isArray(t.outspends) ? t.outspends[read.advert.bondVout] : undefined;
    const spent = typeof said === 'boolean' ? said : null;
    bonds.push({ txid: tx.txid, txidHex: t.txid, vout: read.advert.bondVout, nodePubkey: read.advert.nodePubkey, ancestor, spent, read,
      advert: ancestor ? null : read.advert, height: t.height, pos: t.pos });
  }
  const outpoint = (b) => b.txidHex + ':' + b.vout;
  // 2. UPDATES: the newest one per bond (signed by the bond's key - checked in step 3 for the newest only), and the
  // re-affirmation payloads (an ancestor's bond counts on testnet4 only with one)
  const updates = new Map();                                             // bond outpoint -> [{ u, height, pos, txid }] newest first
  const reaffirmations = [];
  for (const { t, tx } of proven) {
    if (!paysMarkerProgram(tx, bondMarker('testnet'))) continue;
    for (const c of commitmentsOf(tx)) {
      const r = readReaffirmationPayload(c);
      if (r && same(r.networkPrefix, NETWORK_ID_TESTNET4.subarray(0, 8))) reaffirmations.push(r.signature);
    }
    const u = readAdvertUpdate(tx, { network: 'testnet' });
    if (!u.ok) continue;
    const b = bonds.find((x) => same(x.txid, u.bondTxid) && x.vout === u.bondVout);
    if (!b) { rejected.push({ txid: t.txid, why: 'an update of a bond not found' }); continue; }
    if (!same(u.nodePubkey, b.nodePubkey)) { rejected.push({ txid: t.txid, why: 'an update by another key than the bond\'s' }); continue; }
    const k = outpoint(b);
    updates.set(k, [...(updates.get(k) || []), { u, height: t.height, pos: t.pos, txid: t.txid }].sort((x, y) => y.height - x.height || y.pos - x.pos));
  }
  // 3. THE NODES: a live bond, signed by its key, re-affirmed if it is an ancestor's, with its newest signed advertisement
  const nodes = [];
  const unaffirmed = new Set(reaffirmations.map((_, i) => i));
  for (const b of bonds) {
    if (b.spent) { rejected.push({ txid: b.txidHex, why: 'the bond is spent' }); continue; }
    if (b.spent === null) { rejected.push({ txid: b.txidHex, why: 'not yet known whether the bond is spent' }); continue; }
    const list = updates.get(outpoint(b)) || [];
    if (b.ancestor && !list.length) { rejected.push({ txid: b.txidHex, why: 'an ancestor bond with no Arena advertisement' }); continue; }
    if (!sig(b.read.signature, b.read.id, b.nodePubkey)) { rejected.push({ txid: b.txidHex, why: 'the bond\'s advertisement is not signed by its key' }); continue; }
    if (b.ancestor) {
      const msg = reaffirmationMessage({ networkId: NETWORK_ID_TESTNET4, bondTxid: b.txid, bondVout: b.vout });
      const hit = [...unaffirmed].find((i) => sig(reaffirmations[i], msg, b.nodePubkey));
      if (hit === undefined) { rejected.push({ txid: b.txidHex, why: 'an ancestor bond not re-affirmed for testnet4' }); continue; }
      unaffirmed.delete(hit);
    }
    const n = list.find((x) => sig(x.u.signature, x.u.advertId, x.u.nodePubkey)) || null;
    const advert = n ? n.u.advert : b.advert;
    if (!advert) { rejected.push({ txid: b.txidHex, why: 'no Arena advertisement signed by this bond\'s key' }); continue; }
    const endpoint = String(advert.endpoint || '');
    const base = endpoint.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/+$/, '');
    nodes.push({ key: toHex(advert.nodePubkey), endpoint, base, hostedGames: (advert.hostedGames || []).map((g) => toHex(g)),
      bond: outpoint(b), advertTxid: n ? n.txid : b.txidHex, height: n ? n.height : b.height });
  }
  return { nodes, bonds: bonds.length, rejected };
}
