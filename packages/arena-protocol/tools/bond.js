// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Builds a bond funding transaction the shape section 25.1 describes, for
// tests and vectors. NOT part of the protocol: nothing in `src/` imports it,
// and a node does not build transactions.
//
// It exists because there is no BLWP bond on mainnet to point at. The reading
// side is measured against real mainnet transactions - three of them, txids
// matching Bitcoin's own - and this only assembles the shape those same
// readers then have to accept: the advertisement body in the witness, and an
// `OP_RETURN` output committing to its id.
//
// The dust output to BOND_MARKER is here (regtest by default; testnet has its
// own program). 2026-09-08. Mainnet still has no marker.
import { reaffirmationPayload } from '../src/reaffirm.js';
import { encodeAdvert, advertId, joinSignedAdvert } from '../src/advert.js';
import { meetsTarget } from '../src/chain.js';
import { bondMarker } from '../src/constants.js';
import { advertUpdatePayload } from '../src/advert-update.js';

const varint = (n) => {
  if (n < 0xfd) return [n];
  if (n <= 0xffff) return [0xfd, n & 255, (n >> 8) & 255];
  return [0xfe, n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
};
const u32 = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
const u64 = (n) => {
  let v = BigInt(n); const out = [];
  for (let i = 0; i < 8; i++) { out.push(Number(v & 255n)); v >>= 8n; }
  return out;
};
const push = (bytes) => [...varint(bytes.length), ...bytes];

/**
 * One input, a bond output, and the commitment; the body in the witness.
 *
 * `commitment` can be overridden to build a transaction that commits to
 * something else - that is the swapped-endpoint case, and it has to be
 * buildable or the refusal is never measured.
 */
export function bondTransaction(advert, {
  commitment = advertId(advert),
  // 64 zero bytes by default, which is a signature that verifies under no key.
  // A fixture that forgets to sign is refused rather than quietly accepted.
  signature = new Uint8Array(64),
  body = joinSignedAdvert(encodeAdvert(advert), signature),
  value = 100000000,
  previousTxid = new Uint8Array(32).fill(0xab),
  previousVout = 0,
  network = 'regtest',
  outputKey = new Uint8Array(32).fill(0x77),
  // A TRANSACTION THAT PAYS NO MARKER, for a fixture that needs one. 5A.2
  // makes the dust output mandatory, so this builds something the census must
  // NOT find - there is no other way to write that case.
  marker = true,
  // THE MARKER PROGRAM ITSELF, for a fixture of the ancestor network's bond (ancestor.js ancestorMarker)
  markerProgram = null,
} = {}) {
  // A P2TR output: OP_1 <32 bytes>. "A P2TR output is a 32-byte key and looks
  // like every other one" (25.1) - which is exactly why the marker is needed.
  //
  // THOSE 32 BYTES USED TO BE 0x77 REPEATED: a key derived from nothing, which
  // no verifier could ever recompute, so every fixture bond was unfalsifiable.
  // Now the caller passes the output key `bond-script.js` builds from the node
  // key, the arbitration set and the maturity - and a caller that passes none
  // gets the old filler, which is fine for a fixture testing the marker or the
  // commitment and useless for one testing the key.
  const bondScript = [0x51, 0x20, ...outputKey];
  const markerScript = [0x51, 0x20, ...(markerProgram || bondMarker(network))];
  const opReturn = [0x6a, ...push([...commitment])];

  const out = [
    ...u32(1),                                   // version
    0x00, 0x01,                                  // marker, flag
    ...varint(1),
    ...previousTxid, ...u32(previousVout),
    ...varint(0),                                // no scriptSig; the witness carries it
    ...u32(0xffffffff),
    ...varint(marker ? 3 : 2),
    ...u64(value), ...push(bondScript),
    ...(marker ? [...u64(330), ...push(markerScript)] : []),
    ...u64(0), ...push(opReturn),
    ...varint(1), ...push([...body]),            // one witness item: the advertisement
    ...u32(0),                                   // locktime
  ];
  return new Uint8Array(out);
}

/**
 * A block of transactions, and the 80-byte header that commits to them - MINED.
 *
 * The nonce is ground until the hash meets the target, because a header that
 * was not mined is now refused, and a fixture that could not be refused would
 * be measuring nothing. The default difficulty is deliberately trivial - a
 * target just under 2^255, so roughly every second nonce works - since the
 * point of these fixtures is the structure, and mining at mainnet difficulty in
 * a test is not possible.
 */
export function blockOf(hash256, txids, {
  previous = new Uint8Array(32),
  bits = [0x20, 0x7f, 0xff, 0xff],
  time = 0x5a380a6d,
} = {}) {
  let level = txids.map((t) => t.slice());
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i]; const b = level[i + 1] || a;
      const pair = new Uint8Array(64); pair.set(a, 0); pair.set(b, 32);
      next.push(hash256(pair));
    }
    level = next;
  }
  const header = new Uint8Array(80);
  header.set([0x00, 0x00, 0x00, 0x20], 0);
  header.set(previous, 4);
  header.set(level[0], 36);
  header.set(u32(time), 68);
  header.set([bits[3], bits[2], bits[1], bits[0]], 72);

  for (let nonce = 0; ; nonce++) {
    header.set(u32(nonce), 76);
    if (meetsTarget(header)) return { header, root: level[0], nonce };
    if (nonce > 5000000) throw new Error('these bits are too hard to mine in a test');
  }
}

/**
 * AN ADVERTISEMENT UPDATE OF AN EXISTING BOND (§5A.2), for fixtures: the marker dust, OP_RETURN "ARN" 'A' bond_outpoint
 * H(advertisement), and the signed body as the one witness item. `bondTxid` is in the byte order parseTransaction
 * computes. Spends no bond and pays none.
 */
export function advertUpdateTransaction(advert, {
  bondTxid, bondVout = 0,
  signature = new Uint8Array(64),
  previousTxid = new Uint8Array(32).fill(0xac),
  network = 'regtest',
} = {}) {
  const payload = advertUpdatePayload({ bondTxid, bondVout, advertIdBytes: advertId(advert) });
  const body = joinSignedAdvert(encodeAdvert(advert), signature);
  return new Uint8Array([
    ...u32(1), 0x00, 0x01,
    ...varint(1), ...previousTxid, ...u32(0), ...varint(0), ...u32(0xffffffff),
    ...varint(2),
    ...u64(330), ...push([0x51, 0x20, ...bondMarker(network)]),
    ...u64(0), ...push([0x6a, ...push([...payload])]),
    ...varint(1), ...push([...body]),
    ...u32(0),
  ]);
}

/**
 * AN ADVERTISEMENT IN THE ANCESTOR'S LAYOUT (ancestor.js), for fixtures of a BLWP-era bond: today's encoding
 * with hosted_games empty, its u16 count taken out again before the 8-byte timestamp.
 */
export function encodeAncestorAdvert(advert) {
  const now = encodeAdvert({ ...advert, hostedGames: [] });
  const out = new Uint8Array(now.length - 2);
  out.set(now.subarray(0, now.length - 10), 0);
  out.set(now.subarray(now.length - 8), now.length - 10);
  return out;
}

/**
 * A RE-AFFIRMATION (§27A.8.3, reaffirm.js), for fixtures: this network's marker dust (so it is findable as an
 * update is) and OP_RETURN "ARN" 'F' network_id[0:8] signature. Spends one named outpoint, no bond; a legacy transaction.
 */
export function reaffirmationTransaction({ networkId, signature, previousTxid = new Uint8Array(32).fill(0xad), network = 'regtest' } = {}) {
  const payload = reaffirmationPayload({ networkId, signature });
  return new Uint8Array([
    ...u32(1),
    ...varint(1), ...previousTxid, ...u32(0), ...varint(0), ...u32(0xffffffff),
    ...varint(2),
    ...u64(330), ...push([0x51, 0x20, ...bondMarker(network)]),
    // 76 bytes: past a direct push (75), so OP_PUSHDATA1 and its length byte
    ...u64(0), ...push([0x6a, 0x4c, payload.length, ...payload]),
    ...u32(0),
  ]);
}
