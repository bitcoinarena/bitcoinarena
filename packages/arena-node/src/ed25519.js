// AN Ed25519 CHECK FOR A GAME MANIFEST'S SIGNATURE (kanban #202, §0A.3), as arena-protocol/src/manifest.js takes it injected:
// verifyEd25519(signature, digest, key) with a raw 32-byte public key. node:crypto only - the protocol package carries
// no curve.
import { createPublicKey, verify } from 'node:crypto';

const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');

export function verifyEd25519(signature, digest, key) {
  if (!(key instanceof Uint8Array) || key.length !== 32) return false;
  const pub = createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(key)]), format: 'der', type: 'spki' });
  return verify(null, Buffer.from(digest), pub, Buffer.from(signature));
}
