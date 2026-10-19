// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A FEDIMINT INVITE NAMING EVERY GUARDIAN (src/invite.js): byte for byte the stock one-guardian invite of the testnet
// federation, and one naming all seven reads back as all seven.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inviteForGuardians, readInvite } from '../src/invite.js';

// the testnet federation's own invite, written by `fedimint-cli invite-code 0`
const STOCK = 'fed11qgqr2vmhwden5te0vfjk2mrfde4juarpd9krzdejxdjnytn5wvhxuet59anh2ctjv35kzm3dxyhkwatpwfjxjctwqqqjqvm6uqddr6dmxk6k9ra26dzhuckkn5pkal52xj70cgxtxx6zhd67p36ded';
const FED = Buffer.from('337ae01ad1e9bb35b5628faad3457e62d69d036efe8a34bcfc20cb31b42bb75e', 'hex');
const url = (k) => `wss://seat.example.com/guardian-${k}/guardian`;

test('the stock one-guardian invite is what this writes for guardian 1, and reads back', () => {
  const read = readInvite(STOCK);
  assert.deepEqual(read.guardians, [{ url: url(1), peer: 0 }]);
  assert.equal(read.federationId, FED.toString('hex'));
  assert.equal(inviteForGuardians(new Uint8Array(FED), [{ url: url(1), peer: 0 }]), STOCK);
});

test('an invite naming all seven guardians names all seven, and a broken one is refused', () => {
  const all = inviteForGuardians(new Uint8Array(FED), [1, 2, 3, 4, 5, 6, 7].map((k) => ({ url: url(k), peer: k - 1 })));
  const read = readInvite(all);
  assert.equal(read.guardians.length, 7);
  assert.deepEqual(read.guardians[6], { url: url(7), peer: 6 });
  assert.equal(read.federationId, FED.toString('hex'));
  const broken = all.slice(0, -1) + (all.at(-1) === 'q' ? 'p' : 'q');
  assert.throws(() => readInvite(broken), /checksum/);
});
