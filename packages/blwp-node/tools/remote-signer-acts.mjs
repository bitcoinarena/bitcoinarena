// THE TWO ACTS THE REMOTE-SIGNER QUESTION IS ABOUT, through the daemons' own
// Lightning port (src/lnd-port.js) - the only way a BLWP daemon reaches lnd -
// and a reading of what the signer signed the invoice with.
//
//   node remote-signer-acts.mjs create <lncli> <lnddir> <rpcserver> <hash-hex> <amount-msat>
//   node remote-signer-acts.mjs settle <lncli> <lnddir> <rpcserver> <preimage-hex>
//   node remote-signer-acts.mjs signer <bolt11> <node-pubkey-hex>
//
// Used by tools/remote-signer-probe.sh. Measures; decides nothing.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { lndPort } from '../src/lnd-port.js';

const [act, ...a] = process.argv.slice(2);
const hex = (b) => Buffer.from(b).toString('hex');
const portFor = (lncli, lnddir, rpc) => lndPort({ lncli, args: ['--lnddir', lnddir, '--rpcserver', rpc, '--network', 'regtest'] });

/** A BOLT11 request's signature (the last 104 five-bit words) and the hash it signs. */
function invoiceSignature(request) {
  const CH = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const s = request.toLowerCase();
  const at = s.lastIndexOf('1');
  const hrp = s.slice(0, at);
  const words = [...s.slice(at + 1)].map((c) => CH.indexOf(c)).slice(0, -6);
  const bytes = (ws, pad) => {
    let acc = 0; let bits = 0; const out = [];
    for (const w of ws) {
      acc = (acc << 5) | w; bits += 5;
      while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); }
      acc &= (1 << bits) - 1;
    }
    if (pad && bits > 0) out.push((acc << (8 - bits)) & 255);
    return Uint8Array.from(out);
  };
  const sig = bytes(words.slice(-104), false);
  const data = bytes(words.slice(0, -104), true);
  const signed = new Uint8Array(hrp.length + data.length);
  signed.set(Buffer.from(hrp, 'utf8'), 0);
  signed.set(data, hrp.length);
  return { sig, digest: sha256(signed) };
}

try {
  if (act === 'create') {
    const [lncli, dir, rpc, hash, msat] = a;
    const made = await portFor(lncli, dir, rpc).createHeld({ paymentHash: Buffer.from(hash, 'hex'), amountMsat: BigInt(msat) });
    console.log(JSON.stringify({ ok: true, request: made.request, paymentHash: hex(made.paymentHash), amountMsat: String(made.amountMsat) }));
  } else if (act === 'settle') {
    const [lncli, dir, rpc, preimage] = a;
    await portFor(lncli, dir, rpc).settle({ preimage: Buffer.from(preimage, 'hex') });
    console.log(JSON.stringify({ ok: true }));
  } else if (act === 'signer') {
    const [request, nodeKey] = a;
    const { sig, digest } = invoiceSignature(request);
    const ecdsa = secp256k1.Signature.fromBytes(sig.slice(0, 64), 'compact');
    const recovered = hex(ecdsa.addRecoveryBit(sig[64]).recoverPublicKey(digest).toBytes(true));
    const verifies = secp256k1.verify(sig.slice(0, 64), digest, Buffer.from(nodeKey, 'hex'), { prehash: false });
    console.log(JSON.stringify({
      ok: true, signatureBytes: sig.length, recoveryId: sig[64], r: hex(sig.slice(0, 32)), s: hex(sig.slice(32, 64)),
      recoveredKey: recovered, isNodeKey: recovered === nodeKey, ecdsaVerifies: verifies,
    }));
  } else throw new Error(`no act ${act}`);
} catch (e) {
  console.log(JSON.stringify({ ok: false, why: e.message }));
}
