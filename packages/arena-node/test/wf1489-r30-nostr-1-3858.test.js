// kanban #1489 r30-nostr-1 (attacker audit, find-only): A STRANGER SQUATS A PLAYER'S OWN NOSTR KEY FOR THE SOCIAL BONUS.
// POST /feedback/social { nostr: <npub> } links any npub to the signed-in report key (claimName, proof 'name', no ownership asked), and one
// account links to one report key only: the first claim holds it. A stranger signs in with a fresh key and names an honest reporter's own
// report key (it is public: every report, the paid log, the season board name it). When the honest reporter then links his OWN key - the one
// he signs every request with, so he proves it on every call - claimName refuses: "that account is linked to another report key". He loses
// the Nostr +20 % on every report; the stranger cannot even lose anything (a fresh key).
// Safe behaviour: a report key's own Nostr key is always its owner's to link; a squat by another key does not block it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openBountySeason } from '../src/bounty-season.js';

const K = (n) => n.toString(16).padStart(64, '0');

test('a stranger who links an honest reporter\'s own npub first does not block that reporter\'s own Nostr link', async () => {
  const s = openBountySeason();
  const honest = K(1), stranger = K(9);
  // the stranger names the honest reporter's key under the nostr platform (the live check reads that key's kind 3: it follows us)
  assert.equal(s.claimName(stranger, 'nostr', { userId: honest, username: 'npub1honest…' }).ok, true);
  // the honest reporter links his own report key (the one his NIP-98 sign-in proves)
  const mine = s.claimName(honest, 'nostr', { userId: honest, username: 'npub1honest…' });
  assert.equal(mine.ok, true, `the owner of the key is refused his own Nostr link: ${mine.why}`);
  s.record(honest, 'nostr', { member: true, why: 'follows Bitcoin Arena', cause: 'form' });
  assert.equal(s.flagsOf(honest).nostr, true, 'the honest reporter gets his Nostr follow flag');
});
