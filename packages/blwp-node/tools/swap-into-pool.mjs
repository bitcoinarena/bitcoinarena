// A LOSER'S STAKE INTO THE COMMITTEE'S POOL BY A SUBMARINE SWAP - the pieces.
//
// The operator's lnd holds the player's HTLC (invoice, hold and cancel may sit
// on one replaceable node - the owner 2026-09-11). It may NOT settle alone or
// keep the settled money. So before the stake can settle, the operator locks
// the same amount ON-CHAIN in an output only two things can spend:
//
//   claim leaf   <32-byte secret whose sha256 is the stake's hash> AND the
//                committee's group key: OP_SIZE 32 OP_EQUALVERIFY OP_SHA256
//                <H> OP_EQUALVERIFY <pool x> OP_CHECKSIG
//   refund leaf  after a height, the operator's key: <h> OP_CLTV OP_DROP
//                <operator x> OP_CHECKSIG
//   internal key BIP-341's NUMS point - no key path at all
//
// The committee claims into the pool's own output (pool.js) with its 2-of-2
// FROST signature and the secret it rebuilt from the players' shares; the
// claim puts the secret on the chain, and only then can the operator settle
// the player's HTLC - which pays back the coins it locked. It is Lightning
// Loop Out's shape (an off-chain payment for an on-chain HTLC under one hash),
// with the pool as the one claiming.
//
// A HARNESS COMMITTEE, dealt here like payout-regtest.mjs's: the daemons' own
// pool-signing signs only key-path payouts it rebuilt, so this measures the
// mechanism, not the daemons.
//
//   node swap-into-pool.mjs deal   <state.json>
//   node swap-into-pool.mjs swap   <state.json> <hash-hex> <refund-height>
//   node swap-into-pool.mjs claim  <state.json> <txid> <vout> <sats> <secret-hex> <signer ids, e.g. 1,2> <fee-sats>
//   node swap-into-pool.mjs refund <state.json> <txid> <vout> <sats> <fee-sats> <to-script-hex>
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { trustedDealerSplit } from '../../protocol/src/frost.js';
import { nonceGenerate340 } from '../../protocol/src/frost-bip340.js';
import { evenGroupSecret, signShare340, aggregate340 } from '../../protocol/src/frost-bip340.js';
import { poolOutput } from '../../protocol/src/pool.js';
import { tapLeafHash, tapBranchHash, tapTweak, TAPLEAF_VERSION } from '../../protocol/src/bond-script.js';
import { tapSighash, serializeSpend } from '../../protocol/src/bond-spend.js';
import { scalarFrom32, FIELD } from '../../protocol/src/shares.js';
import { toHex, fromHex } from '../../protocol/src/hash.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';

const curve = { ...feldmanGroup, tweakPoint };
const rand = (n) => new Uint8Array(randomBytes(n));
const cat = (...p) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let a = 0; for (const x of p) { o.set(x, a); a += x.length; } return o; };
// BIP-341's provably unspendable internal key: no key path exists.
const NUMS = fromHex('50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0');
const scriptNum = (n) => { const b = []; for (let v = n; v > 0; v >>= 8) b.push(v & 255); if (b[b.length - 1] & 0x80) b.push(0); return Uint8Array.from([b.length, ...b]); };
const load = (f) => JSON.parse(readFileSync(f, 'utf8'));
const save = (f, s) => writeFileSync(f, JSON.stringify(s, null, 1));
const out = (o) => console.log(JSON.stringify(o));

function claimLeaf(hash, poolX) {
  return cat(Uint8Array.from([0x82, 0x01, 0x20, 0x88, 0xa8, 0x20]), hash, Uint8Array.from([0x88, 0x20]), poolX, Uint8Array.from([0xac]));
}
function refundLeaf(height, refundX) {
  return cat(scriptNum(height), Uint8Array.from([0xb1, 0x75, 0x20]), refundX, Uint8Array.from([0xac]));
}

const [act, file, ...a] = process.argv.slice(2);
try {
  if (act === 'deal') {
    const even = evenGroupSecret(scalarFrom32(rand(32)) % FIELD, feldmanGroup);
    const dealt = trustedDealerSplit({ secret: even.secret, max: 2, min: 2, coefficients: [scalarFrom32(rand(32)) % FIELD], curve: feldmanGroup });
    const refundSecret = rand(32);
    const pool = poolOutput({ groupPublicKey: dealt.groupPublicKey, curve });
    save(file, {
      groupPublicKey: toHex(dealt.groupPublicKey), shares: dealt.shares.map((s) => ({ id: s.id, share: s.share.toString(16) })),
      refundSecret: toHex(refundSecret), refundX: toHex(schnorr.getPublicKey(refundSecret)), poolScript: toHex(pool.script),
    });
    out({ ok: true, poolX: toHex(dealt.groupPublicKey.subarray(1)), poolScript: toHex(pool.script), seats: dealt.shares.length });
  } else if (act === 'swap') {
    const s = load(file);
    const [hash, height] = [fromHex(a[0]), Number(a[1])];
    const claim = claimLeaf(hash, fromHex(s.groupPublicKey).subarray(1));
    const refund = refundLeaf(height, fromHex(s.refundX));
    const [cl, rl] = [tapLeafHash(claim), tapLeafHash(refund)];
    const root = tapBranchHash(cl, rl);
    const { outputKey, parity } = tweakPoint(NUMS, tapTweak(NUMS, root));
    Object.assign(s, {
      hash: a[0], refundHeight: height, claimScript: toHex(claim), refundScript: toHex(refund),
      claimLeaf: toHex(cl), refundLeaf: toHex(rl), parity, swapScript: toHex(cat(Uint8Array.from([0x51, 0x20]), outputKey)),
    });
    save(file, s);
    out({ ok: true, swapScript: s.swapScript, claimScript: s.claimScript, refundScript: s.refundScript });
  } else if (act === 'claim' || act === 'refund') {
    const s = load(file);
    const [txid, vout, sats] = [fromHex(a[0]).reverse(), Number(a[1]), BigInt(a[2])];
    const isClaim = act === 'claim';
    const fee = BigInt(isClaim ? a[5] : a[3]);
    const to = isClaim ? fromHex(s.poolScript) : fromHex(a[4]);
    const outputs = [{ value: sats - fee, script: to }];
    const inputs = [{ txid, vout, sequence: isClaim ? 0xfffffffd : 0xfffffffe }];
    const locktime = isClaim ? 0 : s.refundHeight;
    const leafHash = fromHex(isClaim ? s.claimLeaf : s.refundLeaf);
    const message = tapSighash({ locktime, inputs, prevouts: [{ value: sats, script: fromHex(s.swapScript) }], outputs, inputIndex: 0, leafHash });
    const control = cat(Uint8Array.from([TAPLEAF_VERSION | s.parity]), NUMS, fromHex(isClaim ? s.refundLeaf : s.claimLeaf));
    let signature;
    let signedBy;
    if (isClaim) {
      const ids = a[4].split(',').map(Number);
      const gk = fromHex(s.groupPublicKey);
      const seats = s.shares.filter((x) => ids.includes(x.id)).map((x) => {
        const share = BigInt('0x' + x.share);
        const hiding = nonceGenerate340(rand(32), share);
        const binding = nonceGenerate340(rand(32), share);
        return { id: x.id, share, hiding, binding, commitment: { id: x.id, hiding: feldmanGroup.pointFromScalar(hiding), binding: feldmanGroup.pointFromScalar(binding) } };
      });
      const cs = seats.map((x) => x.commitment);
      signature = aggregate340({
        commitments: cs, message, groupPublicKey: gk, curve: feldmanGroup,
        shares: seats.map((x) => signShare340({ id: x.id, share: x.share, groupPublicKey: gk, nonces: { hiding: x.hiding, binding: x.binding }, message, commitments: cs, curve: feldmanGroup })),
      }).signature;
      signedBy = `${seats.length} of ${s.shares.length}`;
    } else {
      signature = schnorr.sign(message, fromHex(s.refundSecret), rand(32));
      signedBy = 'the operator\'s refund key';
    }
    const signingKey = isClaim ? fromHex(s.groupPublicKey).subarray(1) : fromHex(s.refundX);
    const stack = isClaim ? [signature, fromHex(a[3])] : [signature];
    const raw = serializeSpend({ locktime, inputs, outputs, witnesses: [[...stack, fromHex(isClaim ? s.claimScript : s.refundScript), control]] });
    out({ ok: true, raw: toHex(raw), signedBy, verifiesLocally: schnorr.verify(signature, message, signingKey), valueOut: String(sats - fee) });
  } else throw new Error(`no act ${act}`);
} catch (e) {
  out({ ok: false, why: e.message });
}
