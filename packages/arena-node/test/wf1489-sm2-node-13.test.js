// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 state machine audit round 2 (node lifecycle, a restart in every state): THE OWNER REVOKES EVERY OPERATOR TOKEN, THE NODE RESTARTS,
// AND A NEW FULL-SCOPE TOKEN IS MINTED. operator-tokens.js first() mints the pairing token (read, vote, config) "with no token kept" - and
// server.js calls it at every start. The store cannot tell "never paired" from "the owner revoked them all" (both are []), so after the owner
// revoked every token (a leaked pairing URI, a lost operator laptop) the next restart - an update, a reboot, the owner's own restart button -
// mints a fresh token with the VOTE scope (POST /operator/vote: the node's bond key signs a ballot vote, §27A.7.3, weighted by its bond) and
// writes its URI into the log and <db>.operator-pairing, where the revoked one had leaked from. Invariant (spec §27A.7.7, "minting and
// revoking a token is an owner action"): a token exists only because the owner minted it or the node never had one; a revoke survives a restart.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createOperatorTokens } from '../src/operator-tokens.js';

// the store as main.js keeps it: a file beside the database, read again at the next start
const fileStore = () => { let l = []; return { read: () => JSON.parse(JSON.stringify(l)), write: (x) => { l = JSON.parse(JSON.stringify(x)); } }; };

test('a revoke of every operator token survives a restart: no new pairing token is minted', () => {
  const store = fileStore();
  const logged = [];
  // first start: the pairing token, printed
  const start1 = createOperatorTokens({ store, log: (l) => logged.push(l) });
  const pairing = start1.first('https://seat.example');
  assert.ok(pairing, 'the first start mints the pairing token');
  // the owner revokes it (its URI leaked): no token is valid any more
  assert.equal(start1.revoke(pairing.id).ok, true);
  assert.deepEqual(start1.list(), []);
  assert.equal(start1.check(`Bearer ${pairing.token}`, 'vote').ok, false);
  // the node restarts (an update, a reboot): server.js calls first() again
  const start2 = createOperatorTokens({ store, log: (l) => logged.push(l) });
  const again = start2.first('https://seat.example');
  assert.equal(again, null, `the owner revoked every token, yet the restart minted a new one with scopes ${again ? again.scopes.join(', ') : ''} and logged ${logged.length} pairing URI(s)`);
  assert.deepEqual(start2.list(), [], 'no operator token the owner did not mint');
});
