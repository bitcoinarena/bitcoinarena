// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3669: the seats posted Next Block and Up/Down rounds up to 72 h ahead with census heights 163,017-163,068 before #3548 reached them,
// and those roots count a template-1 bond confirmed at 162,922. A client reading #3548 at every census height refused that bond, its census
// hash differed from the round's ("its census hashes to 7b06993b96836e84, and this round names c63eb2681b580ddd"), and no paid join was seated.
// #3548 is read from census height 163,069 on: a census below it is read as written, from it on the bond is out - at the seat and the client alike.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maturityStands, legacyV1Counts, BOND_V1_RULE_FROM_CENSUS } from '../../arena-protocol/src/bond-script.js';

const v1 = { bondScriptTemplateVersion: 1 };
const op = { txid: 'ab'.repeat(32), vout: 0 };

test('#3669 a template-1 bond confirmed at 162922 counts in a census below 163069, and not from it on', () => {
  assert.equal(BOND_V1_RULE_FROM_CENSUS.testnet4, 163069);
  assert.equal(maturityStands(v1, 162922, 'testnet4', op, 163068).ok, true, 'the posted rounds\' census (163068) is read as written');
  assert.equal(maturityStands(v1, 162922, 'testnet4', op, 163017).ok, true);
  const later = maturityStands(v1, 162922, 'testnet4', op, 163069);
  assert.equal(later.ok, false, 'from 163069 #3548 holds');
  assert.match(later.why, /legacy genesis bonds/);
  // no census height given (a caller outside a census): #3548 as before
  assert.equal(legacyV1Counts('testnet4', 162922, op).ok, false);
  // the legacy genesis bonds and pre-156038 bonds count at every height
  assert.equal(legacyV1Counts('testnet4', 150000, op, 170000).ok, true);
});
