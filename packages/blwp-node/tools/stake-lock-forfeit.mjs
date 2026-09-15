// THE COMMITTEE'S FORFEIT OF ONE STAKE LOCK (FEDERATION.md, rehearsal step 2).
//
// A forfeit is a BIP-340 signature by the lock's claim_pk over its contract id
// (fedimint-lnv2-common contracts.rs: `forfeit_message` is the id itself). The
// committee only SIGNS; it submits nothing. The guardians then let the lock
// be spent with `Cancel(sig)` - and the transaction must be signed by the
// lock's refund_pk, the player (lnv2-server lib.rs:491-497).
//
// Signed with this repo's own FROST 2-of-2 (protocol/src/frost-bip340.js),
// two rounds, with the shares tools/stake-lock-keys.mjs kept in <keys.json>.
// `signer nodes` names who takes part: "1,2" is the committee; "1" is one signer node alone,
// whose signature must not verify - that is refusal (a).
//
//   node tools/stake-lock-forfeit.mjs <keys.json> <contract-id-hex> [signer nodes=1,2]
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { signShare340, aggregate340 } from '../../protocol/src/frost-bip340.js';
import { nonceGenerate340 } from '../../protocol/src/frost-bip340.js';
import { toHex, fromHex } from '../../protocol/src/hash.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';

const [file, contractIdHex, signerNodesArg = '1,2'] = process.argv.slice(2);
if (!file || !/^[0-9a-f]{64}$/.test(contractIdHex || ''))
  throw new Error('usage: node tools/stake-lock-forfeit.mjs <keys.json> <contract-id-hex> [signer nodes=1,2]');
const curve = { ...feldmanGroup, tweakPoint };
const keys = JSON.parse(readFileSync(file, 'utf8'));
const claimPk = fromHex(keys.claimPk);
const message = fromHex(contractIdHex);
const wanted = signerNodesArg.split(',').map(Number);
const signerNodes = keys.signerNodes.filter((s) => wanted.includes(Number(s.signerNode)));
if (signerNodes.length !== wanted.length) throw new Error(`no such signer node among ${keys.signerNodes.map((s) => s.signerNode).join(',')}`);

// ROUND ONE: each signer node's nonce commitment. ROUND TWO: each signer node's share over
// the same list. Nothing here puts two shares in one signer node's hands except the
// harness that holds both files - the arithmetic is each signer node's own.
const signers = signerNodes.map((s) => {
  const share = BigInt('0x' + s.share);
  const hiding = nonceGenerate340(new Uint8Array(randomBytes(32)), share);
  const binding = nonceGenerate340(new Uint8Array(randomBytes(32)), share);
  return { id: s.signerNode, share, hiding, binding,
    commitment: { id: s.signerNode, hiding: curve.pointFromScalar(hiding), binding: curve.pointFromScalar(binding) } };
});
const commitments = signers.map((s) => s.commitment);
const shares = signers.map((s) => signShare340({
  id: s.id, share: s.share, groupPublicKey: claimPk, nonces: { hiding: s.hiding, binding: s.binding },
  message, commitments, curve,
}));
const { signature } = aggregate340({ commitments, message, groupPublicKey: claimPk, shares, curve });
console.log(JSON.stringify({
  signerNodes: signers.map((s) => s.id).join(','),
  signature: toHex(signature),
  verifiesUnderClaimPk: schnorr.verify(signature, message, claimPk.subarray(1)),
}));
