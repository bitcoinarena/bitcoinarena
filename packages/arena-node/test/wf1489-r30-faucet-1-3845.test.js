// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 r30-faucet-1 (a way round #2468 "the address paid is the address checked"): POST /feedback checks the content's lnAddress and
// reportAddress(raw event) - the content's address, so the signed lud16 tag is never checked. The store then keeps keptEvent(e): when a seed
// phrase stands anywhere in the report, the whole content is replaced by { removed } and only the strict tags stay - lud16 among them. The
// payout reads addressOf() from that kept event: the content's checked address is gone and the unchecked lud16 tag is paid.
// Safe: the address a reward pays to is the one checked at send (or none).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openFeedbackStore, FEEDBACK_KIND, reportAddress } from '../src/feedback-store.js';
import { eventId } from '../src/nostr-relay.js';

const hex = (b) => Buffer.from(b).toString('hex');
const SEED = 'abandon ability able about above absent absorb abstract absurd abuse access accident';

test('#1489-r30-faucet-1 a seed phrase in the words does not swap the checked content lnAddress for the unchecked lud16 tag at payout', () => {
  const s = openFeedbackStore();
  const secret = new Uint8Array(32).fill(7), pubkey = hex(schnorr.getPublicKey(secret));
  // the seed split over the two boxes (six words each): each string alone holds no run, so the kept content is dropped whole (kanban #2676)
  const w = SEED.split(' ');
  const words = { happened: `The lobby shows a round as open after its entry close, and a join then fails with a refusal. ${w.slice(0, 6).join(' ')}`,
    expected: `${w.slice(6).join(' ')} it should refuse at once`, lnAddress: 'bounty@wallet.example.com' };
  const e = { pubkey, created_at: Math.floor(Date.now() / 1000), kind: FEEDBACK_KIND, tags: [['t', 'bug'], ['lud16', 'other@unchecked.example.net']], content: JSON.stringify(words) };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), secret));
  // what faucet.mjs POST /feedback checks: lnAddressWorks(words.lnAddress), and reportAddress(e) when it differs (here it does not)
  const checkedAtSend = [String(words.lnAddress), reportAddress(e)];
  const kept = s.take(e);
  assert.ok(kept.ok, `kept: ${JSON.stringify(kept)}`);
  const paidTo = s.addressOf(e.id);   // payToAddress hands exactly this to invoiceFor
  console.log('  MEASURED:', JSON.stringify({ checkedAtSend, paidTo }));
  assert.ok(paidTo === null || checkedAtSend.includes(paidTo), `the reward goes to ${paidTo}, an address never checked (checked: ${checkedAtSend.join(', ')})`);
});
