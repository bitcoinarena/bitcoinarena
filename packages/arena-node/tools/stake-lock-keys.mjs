// THE KEYS A STAKE LOCK NAMES (FEDERATION.md, rehearsal step 1).
//
//   claim_pk   the round's settlement committee key - here a 2-of-2 made by
//              this repo's own key ceremony (arena-protocol/src/dkg.js with the
//              daemon's curve): each signer node deals to both, each opens only its
//              own envelopes, each combines; both must reach ONE group key.
//              Not a trusted dealer. (Bit-matching this ceremony against an
//              audited FROST is a later condition, not this step.)
//   refund_pk  the player's key
//   H(P)       the stake's hash; P is the player's
//
// Everything is written to <state.json> so later steps can sign with it; the
// public half is printed.
//
//   node tools/stake-lock-keys.mjs <state.json>
import { writeFileSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { epochId, dealContribution, openMyContribution, combineShares } from '../../arena-protocol/src/dkg.js';
import { scalarFrom32, FIELD } from '../../arena-protocol/src/shares.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';

const out = process.argv[2];
if (!out) throw new Error('usage: node tools/stake-lock-keys.mjs <state.json>');
const rand = (n) => new Uint8Array(randomBytes(n));
const curve = { ...feldmanGroup, tweakPoint };
const belowOrder = () => {
  for (;;) { const s = rand(32); const v = scalarFrom32(s); if (v > 0n && v < FIELD) return s; }
};

const NEEDED = 2;
const secrets = [rand(32), rand(32)];
const signerNodes = secrets.map((s) => schnorr.getPublicKey(s));
const id = epochId(signerNodes);
const contributions = [];
for (let i = 0; i < signerNodes.length; i++) {
  const e = rand(32);
  const dealt = await dealContribution({
    secret: belowOrder(), signerNodes, epochId: id, from: signerNodes[i],
    ephemeralSecret: e, ephemeralPubkey: curve.pointX(e),
    coefficients: Array.from({ length: NEEDED - 1 }, () => scalarFrom32(rand(32)) % FIELD),
    needed: NEEDED, curve,
  });
  if (!dealt.ok) throw new Error(`signer node ${i} could not deal: ${dealt.why}`);
  contributions.push(dealt.contribution);
}
const held = [];
for (let i = 0; i < signerNodes.length; i++) {
  const opened = [];
  for (const c of contributions) {
    const mine = await openMyContribution(c, { pubkey: signerNodes[i], secret: secrets[i], curve });
    if (!mine.ok) throw new Error(`signer node ${i} could not open a contribution: ${mine.why}`);
    opened.push(mine);
  }
  const combined = combineShares({ opened, signerNodes, contributions, curve });
  if (!combined.ok) throw new Error(`signer node ${i} could not combine: ${combined.why}`);
  held.push(combined);
}
const groupKeys = held.map((h) => toHex(h.groupPublicKey));
if (groupKeys[0] !== groupKeys[1]) throw new Error(`the two signer nodes reached two keys: ${groupKeys.join(' / ')}`);

const playerSecret = secp256k1.utils.randomSecretKey();
const preimage = rand(32);
const hash = createHash('sha256').update(preimage).digest();
const state = {
  claimPk: groupKeys[0],
  signerNodes: held.map((h, i) => ({ signerNode: h.signerNode, identity: toHex(secrets[i]), share: h.share.toString(16) })),
  refundPk: toHex(secp256k1.getPublicKey(playerSecret, true)),
  playerSecret: toHex(playerSecret),
  preimage: toHex(preimage),
  hash: toHex(hash),
};
writeFileSync(out, JSON.stringify(state, null, 1));
console.log(JSON.stringify({ claimPk: state.claimPk, refundPk: state.refundPk, hash: state.hash, signerNodesAgree: true }));
