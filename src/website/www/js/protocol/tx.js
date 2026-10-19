// A Bitcoin transaction, read far enough to find an endpoint in it.
//
// Section 25.1 puts discovery in the funding transaction itself: the body of
// the advertisement rides in the witness, and the bond output commits to
// `H(NodeAdvertisement)`. That is what makes discovery need no directory - but
// only if the commitment is READ OUT OF THE TRANSACTION. Handed in beside it,
// a commitment is worth nothing: whoever hands over the advertisement hands
// over the hash of the advertisement they wanted, and every check passes.
//
// So the txid is COMPUTED here, never accepted. It is the double hash of the
// transaction without its marker, flag and witness - the one number a page
// cannot choose without changing the bytes it is derived from - and it is what
// the merkle proof must then be about.
//
// NOTHING HERE IS BITCOIN CONSENSUS. No script is executed, no signature is
// checked, no amount is summed. It parses a serialization and answers two
// questions: what is this transaction called, and what does it commit to.
import { sha256bytes } from './sha256.js';

/** Bitcoin hashes twice, everywhere. */
export const hash256 = (bytes) => sha256bytes(sha256bytes(bytes));

/** OP_RETURN: the opcode that makes an output a commitment rather than money. */
export const OP_RETURN = 0x6a;

function need(bytes, at, n, what) {
  if (at + n > bytes.length)
    throw new Error(`the transaction ends inside its ${what}`);
  return at + n;
}

/**
 * Bitcoin's variable-length integer.
 *
 * Refuses the long forms of a short number. A parser that accepted `fd0100`
 * for 1 would give two byte strings the same meaning, and the txid is a hash
 * OF the bytes - two spellings would be two names for one transaction.
 */
export function readVarint(bytes, at) {
  need(bytes, at, 1, 'length');
  const first = bytes[at];
  if (first < 0xfd) return { value: first, next: at + 1 };
  if (first === 0xfd) {
    need(bytes, at, 3, 'length');
    const v = bytes[at + 1] | (bytes[at + 2] << 8);
    if (v < 0xfd) throw new Error('a length is written longer than it needs to be');
    return { value: v, next: at + 3 };
  }
  if (first === 0xfe) {
    need(bytes, at, 5, 'length');
    const v = (bytes[at + 1] | (bytes[at + 2] << 8) | (bytes[at + 3] << 16)
      | (bytes[at + 4] << 24)) >>> 0;
    if (v <= 0xffff) throw new Error('a length is written longer than it needs to be');
    return { value: v, next: at + 5 };
  }
  // 0xff is eight bytes. A transaction that large does not exist and a length
  // past what an array can hold is refused rather than truncated.
  throw new Error('a length larger than this parser will read');
}

function readSlice(bytes, at, what) {
  const { value, next } = readVarint(bytes, at);
  const end = need(bytes, next, value, what);
  return { bytes: bytes.slice(next, end), next: end };
}

/**
 * Parses a transaction and computes its txid.
 *
 * The txid covers version, inputs, outputs and locktime and NOT the witness -
 * that is what segwit is - so a body carried in the witness is not committed
 * to by the name of the transaction. It is committed to by an output, and
 * `commitmentsOf` is where that is read. Both halves are needed and neither is
 * enough: the witness says what the advertisement is, the output says that
 * this transaction meant it.
 */
export function parseTransaction(raw) {
  if (!(raw instanceof Uint8Array) || raw.length < 10)
    throw new Error(`a transaction is more than ${raw && raw.length} bytes`);

  let at = need(raw, 0, 4, 'version');
  const version = (raw[0] | (raw[1] << 8) | (raw[2] << 16) | (raw[3] << 24)) >>> 0;

  const segwit = raw[4] === 0x00 && raw[5] === 0x01;
  if (segwit) at += 2;
  const bodyFrom = at;

  const ins = readVarint(raw, at);
  if (ins.value === 0) throw new Error('a transaction with no inputs');
  at = ins.next;
  const inputs = [];
  for (let i = 0; i < ins.value; i++) {
    const end = need(raw, at, 36, 'outpoint');
    const previousTxid = raw.slice(at, at + 32);
    const previousVout = (raw[at + 32] | (raw[at + 33] << 8)
      | (raw[at + 34] << 16) | (raw[at + 35] << 24)) >>> 0;
    const script = readSlice(raw, end, 'input script');
    at = need(raw, script.next, 4, 'sequence');
    inputs.push({ previousTxid, previousVout, script: script.bytes });
  }

  const outs = readVarint(raw, at);
  at = outs.next;
  const outputs = [];
  for (let i = 0; i < outs.value; i++) {
    const end = need(raw, at, 8, 'value');
    let value = 0n;
    for (let b = 7; b >= 0; b--) value = (value << 8n) | BigInt(raw[at + b]);
    const script = readSlice(raw, end, 'output script');
    at = script.next;
    outputs.push({ value, script: script.bytes });
  }
  const bodyTo = at;

  const witnesses = [];
  if (segwit) {
    for (let i = 0; i < inputs.length; i++) {
      const items = readVarint(raw, at);
      at = items.next;
      const stack = [];
      for (let k = 0; k < items.value; k++) {
        const item = readSlice(raw, at, 'witness item');
        at = item.next;
        stack.push(item.bytes);
      }
      witnesses.push(stack);
    }
  }

  const end = need(raw, at, 4, 'locktime');
  const locktime = (raw[at] | (raw[at + 1] << 8) | (raw[at + 2] << 16)
    | (raw[at + 3] << 24)) >>> 0;
  if (end !== raw.length)
    throw new Error(`${raw.length - end} bytes left over after the transaction`);

  // The name of the transaction: the same bytes with the witness taken out.
  const stripped = new Uint8Array(4 + (bodyTo - bodyFrom) + 4);
  stripped.set(raw.subarray(0, 4), 0);
  stripped.set(raw.subarray(bodyFrom, bodyTo), 4);
  stripped.set(raw.subarray(at, at + 4), 4 + (bodyTo - bodyFrom));

  return {
    version, segwit, inputs, outputs, witnesses, locktime,
    txid: hash256(stripped),
  };
}

/**
 * What the outputs commit to: the data push of every `OP_RETURN`.
 *
 * A bond output commits to `H(NodeAdvertisement)` "either in an OP_RETURN
 * output of the funding transaction or in the taproot script path" (5A.2).
 * Only the first form is readable from the transaction alone - a taproot
 * script path is invisible until it is spent - so that is the one discovery
 * can use, and a bond whose commitment is only in the script path is not
 * findable by this. It is not refused here; it is simply not present.
 */
export function commitmentsOf(tx) {
  const out = [];
  for (const o of tx.outputs) {
    const s = o.script;
    if (s.length < 2 || s[0] !== OP_RETURN) continue;
    const op = s[1];
    let from = 2;
    let n = 0;
    if (op >= 1 && op <= 75) n = op;
    else if (op === 0x4c && s.length >= 3) { n = s[2]; from = 3; }
    else if (op === 0x4d && s.length >= 4) { n = s[2] | (s[3] << 8); from = 4; }
    else continue;
    if (from + n !== s.length) continue;     // a push that does not fill the script
    out.push(s.slice(from, from + n));
  }
  return out;
}

/** Every witness item of every input, flattened - a place to look, not a claim. */
export function witnessItemsOf(tx) {
  const out = [];
  for (const stack of tx.witnesses) for (const item of stack) out.push(item);
  return out;
}

/**
 * EVERY WITNESS ITEM, AND EVERY RUN OF CONSECUTIVE ITEMS IN ONE STACK, JOINED.
 *
 * A signed advertisement is 266 bytes (`arena-protocol/tools/advert-layout.mjs`) and Bitcoin Core holds a
 * tapscript witness stack item to 80 - measured on a real node, the bond was refused
 * `bad-witness-nonstandard` with the stack [64 sig, 266 body, 35 script, 33 control]. So §5A.2's body
 * travels in pieces of at most 80 bytes with an `OP_DROP` each, and a reader that only looked at single
 * items would see four fragments and no advertisement at all.
 *
 * Single items come FIRST, so a one-item body - every bond posted before this - is found exactly as it
 * was and at the same cost. The runs are tried after, and a run is believed only if its bytes decode AND
 * its `advertId` matches a commitment in the transaction's own outputs, so joining bytes that were never
 * one body cannot invent an advertisement.
 */
export function witnessRunsOf(tx) {
  const out = witnessItemsOf(tx);
  for (const stack of tx.witnesses) {
    for (let i = 0; i < stack.length; i++) {
      let length = stack[i].length;
      for (let j = i + 1; j < stack.length; j++) {
        length += stack[j].length;
        const run = new Uint8Array(length);
        let at = 0;
        for (let k = i; k <= j; k++) { run.set(stack[k], at); at += stack[k].length; }
        out.push(run);
      }
    }
  }
  return out;
}

/**
 * THE MERKLE ROOT OF A BLOCK'S TRANSACTIONS, Bitcoin's way.
 *
 * An odd level DUPLICATES the last hash here, which is exactly the rule the
 * census refuses to use - `merkleRoot` in `census.js` promotes instead, and
 * says why: duplication is CVE-2012-2459 and lets two leaf sets share a root.
 *
 * This one has no such freedom. It is not a construction of ours, it is a
 * question about a block that already exists, and the only useful answer is
 * the one Bitcoin's own header agrees with. Getting it "right" here would
 * simply fail to match every real block.
 */
export function blockMerkleRoot(txids) {
  if (!txids.length) throw new Error('a block has at least a coinbase');
  let level = txids;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : level[i];
      const pair = new Uint8Array(64);
      pair.set(left, 0);
      pair.set(right, 32);
      next.push(hash256(pair));
    }
    level = next;
  }
  return level[0];
}
