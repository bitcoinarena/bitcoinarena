// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #2869 (measured 2026-11-15 23:46Z, round ac3f97a3): second-host seats 4 and 5 refused a market order's locks with "this signer node holds no
// claim key for that round" - their run ended "no key after 30 runs" while committee seats restarted, and nothing ran it again. The key's one
// reader (claimKeyOf, which the lock, fee-lock, handout and /claim-key checks use) now starts a new run when it holds no key, at most once a
// CLAIM_KEY_AGAIN_MS per committee after a run gave up, never for a committee the node is not on, never twice at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const fn = (name) => { const a = src.indexOf(`  function ${name}(`); assert.ok(a > 0, name); return src.slice(a, src.indexOf('\n  }\n', a)); };

test('#2869 a claim key asked for and not held is made again; a run that gave up is noted, and runs again at most once a minute', () => {
  const of = fn('claimKeyOf');
  assert.match(of, /if \(held && held\.ok\) return held\.pool\.groupPublicKey;/);
  assert.match(of, /if \(r\) claimKeyAgain\(rid\);/, 'not held: a new run is asked');
  const again = fn('claimKeyAgain');
  assert.match(again, /dkg\.epochFor\(/, 'only a committee this node is on');
  assert.match(again, /claimKeyRuns\.has\(key\) \|\| Date\.now\(\) - \(claimKeyGaveUp\.get\(key\) \|\| 0\) < CLAIM_KEY_AGAIN_MS/, 'not while one runs, not within a minute of a give-up');
  assert.match(again, /makeClaimKey\(rid\)/);
  const make = fn('makeClaimKey');
  assert.match(make, /claimKeyGaveUp\.set\(key, Date\.now\(\)\)/, 'a give-up is noted');
  assert.match(make, /claimKeyRuns\.delete\(key\);\n\s+claimKeyGaveUp\.set/, 'and the committee is free to run again');
});
