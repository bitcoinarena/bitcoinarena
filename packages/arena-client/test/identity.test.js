// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHO A TAB IS IN THE LOBBY (M3.3-34): a generated key pair, a name made from
// the public key, and the player's own name over it.
//
// The key is the tab seed's under its own tag - never a round's player key - so
// the seed backup covers it and two tabs are two players. The name decides
// nothing; it is kept in the tab, and cleared it goes back to the generated one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { tabIdentity, generatedName, setPlayerName, playerNameIsValid, CUSTOM_NAME_KEY } from '../src/identity.js';
import { playerFor, importSeed } from '../src/join.js';
import { identitySecretFor } from '../../arena-protocol/src/player-key.js';
import { feldmanGroup } from '../../arena-node/src/curve.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const random = (n) => new Uint8Array(randomBytes(n));
const curve = feldmanGroup;
function tab() {
  const m = new Map();
  return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}

test('a tab generates its identity key once, from its seed, and it is no round\'s player key', () => {
  const storage = tab();
  const me = tabIdentity({ storage, random, curve });
  const again = tabIdentity({ storage, random, curve });
  const seed = Uint8Array.from(Buffer.from(storage.getItem('arena.player.seed'), 'hex'));
  const other = tabIdentity({ storage: tab(), random, curve });
  const facts = {
    sameOnReload: again.pubkeyHex === me.pubkeyHex,
    isTheSeedsIdentity: me.pubkeyHex === toHex(curve.pointX(identitySecretFor(seed))),
    anotherTabAnotherKey: other.pubkeyHex !== me.pubkeyHex,
    notARoundKey: me.pubkeyHex !== toHex(playerFor({ id: random(32) }, { seed, curve }).pubkey),
    noSecretHandedOut: !('secret' in me) && !('seed' in me),
    name: /^[a-z]+-[a-z]+-\d{4}$/.test(me.name), custom: me.custom,
  };
  console.log(`  identity ${me.fingerprint} is ${me.name}:`, JSON.stringify(facts));
  assert.deepEqual(facts, { sameOnReload: true, isTheSeedsIdentity: true, anotherTabAnotherKey: true,
    notARoundKey: true, noSecretHandedOut: true, name: true, custom: false });
  assert.throws(() => tabIdentity({ storage: tab(), random }), /curve/);
});

test('the generated name is the public key\'s: the same key always, different keys mostly different', () => {
  const k = random(32);
  assert.equal(generatedName(k), generatedName(Uint8Array.from(k)));
  const names = new Set(Array.from({ length: 200 }, () => generatedName(random(32))));
  console.log(`  200 random keys, ${names.size} different names`);
  assert.ok(names.size >= 190, `only ${names.size} different names for 200 keys`);
  assert.throws(() => generatedName(random(31)), /32-byte/);
});

test('the player\'s own name replaces the generated one, stays across a reload, and blank brings the generated one back', () => {
  const storage = tab();
  const before = tabIdentity({ storage, random, curve });
  assert.deepEqual(setPlayerName('  Alice   the  Hauler ', { storage }), { ok: true, custom: true, name: 'Alice the Hauler' });
  const named = tabIdentity({ storage, random, curve });
  assert.equal(named.name, 'Alice the Hauler');
  assert.equal(named.custom, true);
  assert.equal(named.generated, before.generated, 'choosing a name changed the generated one');
  assert.equal(named.pubkeyHex, before.pubkeyHex, 'choosing a name changed the key');

  // REFUSED BY NAME, AND NOTHING KEPT: the chosen name stands as it was.
  const refused = ['x'.repeat(25), 'badbell', '<script>', '-dash-first', 'dot.']
    .map((t) => [t, setPlayerName(t, { storage })]);
  for (const [t, r] of refused) assert.equal(r.ok, false, `"${t}" was taken as a name`);
  assert.match(refused[0][1].why, /at most 24/);
  assert.equal(tabIdentity({ storage, random, curve }).name, 'Alice the Hauler');
  assert.equal(playerNameIsValid('Zoë_7').ok, true, 'a letter outside ASCII was refused');

  assert.deepEqual(setPlayerName('   ', { storage }), { ok: true, custom: false });
  assert.equal(storage.getItem(CUSTOM_NAME_KEY), null);
  const back = tabIdentity({ storage, random, curve });
  assert.equal(back.name, before.generated);
  assert.equal(back.custom, false);
});

test('a seed the player imports is a different identity; the name they chose stays theirs', () => {
  const storage = tab();
  const first = tabIdentity({ storage, random, curve });
  setPlayerName('Night Rider', { storage });
  importSeed(toHex(random(32)), { storage });
  const imported = tabIdentity({ storage, random, curve });
  assert.notEqual(imported.pubkeyHex, first.pubkeyHex);
  assert.equal(imported.name, 'Night Rider');
});
