// A NIP-04 ENVELOPE AND A KEY IT WAS NOT SEALED TO.
//
// PRIORITIES: "client wallet-nwc's 'a third key opened an envelope' flakes
// about 1 in 256 (NIP-04 has no MAC)". NIP-04 is AES-256-CBC under the ECDH
// secret with no authentication, so a wrong key yields garbage - and garbage
// whose last byte happens to read as valid PKCS#7 padding (about 1 in 256)
// decrypts without an error. What `nip04Decrypt` does with that is the gap.
//
// DETERMINISTIC, so the count is a number and not a draw: every key and the
// iv come from sha256 of a counter.
//
// MEASURED FIRST, asserted as it stands.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pageCurve } from '../src/page-curve.js';
import { nip04Encrypt, nip04Decrypt } from '../src/nwc.js';
import { sha256 } from '../../protocol/src/hash.js';

const det = (tag, i) => sha256(new TextEncoder().encode(`${tag}:${i}`));
const TRIES = 4096;

test('MEASURED: of 4096 stranger keys, some "open" an envelope sealed to another pair - none sees the message', async () => {
  const mine = det('mine', 0);
  const theirs = det('theirs', 0);
  let n = 0;
  const random = (len) => det('iv', n++).slice(0, len);
  const sealed = await nip04Encrypt('pay_invoice', { secret: mine, theirPubkey: pageCurve.pointX(theirs), curve: pageCurve, random });
  let opened = 0;
  let sawMessage = 0;
  const samples = [];
  for (let i = 0; i < TRIES; i++) {
    const r = await nip04Decrypt(sealed, { secret: det('stranger', i), theirPubkey: pageCurve.pointX(mine), curve: pageCurve });
    if (!r.ok) continue;
    opened++;
    if (r.plaintext === 'pay_invoice') sawMessage++;
    if (samples.length < 3) samples.push(JSON.stringify(r.plaintext));
  }
  console.log(`  FACTS (${TRIES} stranger keys): opened ${opened}, saw the message ${sawMessage}; e.g. ${samples.join(' ')}`);
  assert.deepEqual({ opened, sawMessage }, { opened: 15, sawMessage: 0 });
});
