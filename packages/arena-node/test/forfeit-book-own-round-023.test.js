// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Feedback #023 (Hexbox, 2026-11-12): the #018 fix (a lock goes back only through the round it stakes) sat after the order book's early return, so naming a
// VOID market round signed another round's filled order stake and fee lock back through #bookReturn. The own-round refusal now comes first, for every path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('#023 the own-round refusal comes before the order book\'s rules in Forfeit.message', () => {
  const src = readFileSync(new URL('../src/forfeit.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('  async message(roundIdBytes, entryIdBytes, kind = \'stake\') {'));
  const guard = body.indexOf('const asked = toHex(roundIdBytes), of = this.round.roundsOfEntry(entryIdBytes);');
  const book = body.indexOf('if (book && book.book) return this.#bookReturn(');
  assert.ok(guard > 0 && book > 0, 'both are in message()');
  assert.ok(guard < book, 'the refusal for a lock of another round is checked before #bookReturn');
});
