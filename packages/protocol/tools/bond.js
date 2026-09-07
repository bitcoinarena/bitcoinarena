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
// The dust output to BOND_MARKER that 25.1 requires is NOT here, because
// BOND_MARKER has no value yet and inventing one would settle a genesis
// parameter by accident. What is built is therefore a bond transaction that a
// light client could not FIND; everything about reading it once found holds.
import { encodeAdvert, advertId } from '../src/advert.js';

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
  body = encodeAdvert(advert),
  value = 100000000,
  previousTxid = new Uint8Array(32).fill(0xab),
  previousVout = 0,
} = {}) {
  // A P2TR output: OP_1 <32 bytes>. "A P2TR output is a 32-byte key and looks
  // like every other one" (25.1) - which is exactly why the marker is needed.
  const bondScript = [0x51, 0x20, ...new Uint8Array(32).fill(0x77)];
  const opReturn = [0x6a, ...push([...commitment])];

  const out = [
    ...u32(1),                                   // version
    0x00, 0x01,                                  // marker, flag
    ...varint(1),
    ...previousTxid, ...u32(previousVout),
    ...varint(0),                                // no scriptSig; the witness carries it
    ...u32(0xffffffff),
    ...varint(2),
    ...u64(value), ...push(bondScript),
    ...u64(0), ...push(opReturn),
    ...varint(1), ...push([...body]),            // one witness item: the advertisement
    ...u32(0),                                   // locktime
  ];
  return new Uint8Array(out);
}

/** A block of two transactions, and the 80-byte header that commits to them. */
export function blockOf(hash256, txids, { previous = new Uint8Array(32), bits = [0x17, 0x19, 0x60, 0x45], time = 0x5a380a6d } = {}) {
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
  return { header, root: level[0] };
}
