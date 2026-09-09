// HOW MANY SHARES OF THE POOL KEY ONE PROCESS HOLDS, COUNTED.
//
// M3.3 item 14. Item 10 closed FROST against RFC 9591's own vectors and said
// what it had not done: "the group secret comes from a trusted dealer rather
// than a DKG". Item 17 put the SIGNING on sockets - five daemons, one share
// each, and no secret on the wire - and that is the distribution of the
// signing, not of the key.
//
// THE KEY IS STILL DEALT, and by something outside this repository. There is no
// caller of `trustedDealerSplit` in any `src/`: a daemon takes `poolSeat` as an
// argument to `serve`, so whoever STARTS the seven daemons is the dealer, holds
// all seven shares, and therefore knows the group secret. "No one of them can
// steal" holds among the signers and not against that process.
//
// This file is the measurement before any of that is written, and its numbers
// are the ones letter 14 has to move. It is a pin and not a proof of anything
// good: when the DKG lands, the counts below change and this file says so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dealThePool, curve } from './pool-fixture.js';
import { SHARES_NEEDED, SHARES_TOTAL } from '../../protocol/src/shares.js';
import { reconstruct, scalarFrom32 } from '../../protocol/src/shares.js';

const srcOf = (pkg) => {
  const dir = new URL(`../../${pkg}/src/`, import.meta.url);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => ({ pkg, f, text: readFileSync(new URL(f, dir), 'utf8') }));
};

/**
 * THE NUMBER THIS LETTER EXISTS TO MOVE: 7 of 7.
 *
 * One call to the dealer returns every share, and the harnesses that stand a
 * committee up hand them out afterwards - so the dealing process holds a
 * threshold and then some. Five of seven is what opens the key, so anything at
 * or above five in one place is a single party that can sign alone.
 */
test('one process holds every share of the pool key, which is the fault', () => {
  const dealt = dealThePool();

  assert.equal(dealt.shares.length, SHARES_TOTAL);
  const inOneProcess = dealt.shares.length;
  console.log(`  shares reachable from the dealing process: ${inOneProcess} of ${SHARES_TOTAL}`);
  console.log(`  shares needed to sign alone:               ${SHARES_NEEDED}`);
  console.log(`  so the dealer can sign without asking:     ${inOneProcess >= SHARES_NEEDED}`);
  assert.equal(inOneProcess, SHARES_TOTAL,
    'the dealer no longer returns every share - letter 14 has moved, update this pin');
  assert.ok(inOneProcess >= SHARES_NEEDED,
    'the dealing process no longer holds a threshold - letter 14 has moved, update this pin');

  // AND IT IS NOT A COUNT ONLY: the shares in that one place OPEN the key.
  // Five of the seven, interpolated, are the group secret itself.
  const five = dealt.shares.slice(0, SHARES_NEEDED)
    .map((s) => ({ seat: Number(s.id), value: s.share }));
  // `reconstruct` hands back the 32 bytes themselves, not a result object.
  const secret = reconstruct(five, { needed: SHARES_NEEDED });
  assert.equal(secret.length, 32);
  const rebuilt = curve.pointFromScalar(scalarFrom32(secret));
  assert.deepEqual(rebuilt, dealt.groupPublicKey,
    'five shares from the dealing process did not rebuild the group key');
  console.log('  five of them, interpolated in this process, ARE the group key');
});

/**
 * AND NOTHING IN THE DAEMON GENERATES ONE, which is why the dealer is outside
 * the repository rather than inside it.
 *
 * Pinned as a LIST rather than a count, the way the pool watcher is: a second
 * file learning to make key material is a second place for "no one of them can
 * steal" to be got wrong.
 */
test('no source file deals the pool key, and the daemon is handed its share', () => {
  const src = [...srcOf('protocol'), ...srcOf('blwp-node'), ...srcOf('blwp-client')];

  // The dealer is DEFINED in the protocol and CALLED by nothing that ships.
  const defines = src.filter((s) => /export function trustedDealerSplit/.test(s.text));
  assert.deepEqual(defines.map((s) => `${s.pkg}/${s.f}`), ['protocol/frost.js']);
  const callers = src.filter((s) => /(?<!function )\btrustedDealerSplit\s*\(/.test(s.text)
    && !/export function trustedDealerSplit/.test(s.text));
  assert.deepEqual(callers.map((s) => `${s.pkg}/${s.f}`), [],
    'something that ships now deals the pool key - letter 14 has moved, update this pin');
  console.log('  files under src/ that call the trusted dealer: 0');

  // So the share ARRIVES. `serve` takes it as an argument, which means the
  // caller of `serve` is the party that knows every share.
  const server = src.find((s) => s.pkg === 'blwp-node' && s.f === 'server.js').text;
  assert.match(server, /poolSeat\s*=\s*null/,
    'the daemon no longer takes its share as an argument - letter 14 has moved');
  // A CALL SITE, NOT A MENTION - the same distinction the pool watcher's pin
  // makes. Written as a bare /dkg|dealerless/i first and it matched the COMMENT
  // that says a dealerless DKG is its own letter, which is this sentence being
  // caught by its own regex.
  assert.equal(/new\s+\w*Dkg|\bdkg\.|runDkg\s*\(|new\s+DistributedKey/.test(server), false,
    'the daemon runs a DKG now - letter 14 has moved, update this pin');
  console.log('  the daemon is handed `poolSeat` by whoever starts it: 1 argument, 0 rounds run');

  // AND THE START PATHS THAT EXIST TODAY hold all seven at once, by name, so
  // the claim above is about this repository and not about a hypothesis.
  const tools = readdirSync(new URL('../tools/', import.meta.url))
    .filter((f) => f.endsWith('.mjs'))
    .filter((f) => /trustedDealerSplit/.test(readFileSync(new URL(`../tools/${f}`, import.meta.url), 'utf8')));
  assert.ok(tools.length >= 2, 'the regtest harnesses no longer deal the pool');
  console.log(`  start paths that deal all ${SHARES_TOTAL} shares in one process: ${tools.length} (${tools.join(', ')})`);
});
