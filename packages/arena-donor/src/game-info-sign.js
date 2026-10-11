// THE DEV CLIENT SIGNS A GAME'S DESCRIPTION AND WEBSITE (kanban #276), as it signs the manifest (manifest-sign.js): the
// developer's Ed25519 key, held here, signs H(game_id || description || website) (arena-protocol/src/game-info.js). A seat
// and a page only verify, against the developer key the manifest names; the game id does not move.
import { createPublicKey, sign, verify } from 'node:crypto';
import { gameInfoDigest } from '../../arena-protocol/src/game-info.js';
import { toHex } from '../../arena-protocol/src/hash.js';

export function signGameInfo({ gameId, manifest, description = '', website = '' }, { key, pubkey }) {
  if (Buffer.compare(Buffer.from(manifest.gameDevPubkey), Buffer.from(pubkey)) !== 0)
    throw new Error('that game names another developer key than the one this client holds');
  const digest = Buffer.from(gameInfoDigest(gameId, { description, website }));
  const signature = new Uint8Array(sign(null, digest, key));
  if (!verify(null, digest, createPublicKey(key), signature)) throw new Error('the signature does not verify');
  return { description, website, signature: toHex(signature) };
}
