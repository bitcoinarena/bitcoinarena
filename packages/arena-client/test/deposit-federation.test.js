// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE FIRST DEPOSIT GOES TO THE LOWEST-LOAD FEDERATION (§23A.3): depositFederation over verified statuses -
// the lobby round's federation is not used when another OPEN, known one has a lower load; since 2026-10-13 ("always
// the federation with less funds") a returning player's deposit goes there too, and a withdraw reads the federation holding the most.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { depositFederation, withdrawFederation } from '../src/federations.js';

const A = 'aa'.repeat(32), B = 'bb'.repeat(32), C = 'cc'.repeat(32);
const inviteOf = (fid) => `fed1-invite-of-${fid.slice(0, 4)}`;
const sameFederation = (inv, fid) => inv === inviteOf(fid);
const st = (federation, load, status = 'OPEN') => ({ federation, status, load, invite: inviteOf(federation) });

test('a first deposit lands on the lowest-load OPEN known federation, not the lobby round\'s when it is not the lowest', () => {
  const statuses = [st(A, 4.3333), st(B, 0.0002), st(C, 0.0001, 'DRAINING')];
  const got = depositFederation({ lobbyInvite: inviteOf(A), statuses, held: [], sameFederation });
  assert.deepEqual([got.invite, got.federation, got.lowest], [inviteOf(B), B, true]);
  assert.notEqual(got.invite, inviteOf(A), 'the lobby round\'s federation (load 4.33) is not used');
  assert.match(got.why, /deposit: federation bbbbbbbbbbbbbbbb has the lowest load \(0\.00\)/);
  // the lobby federation is the lowest: it is used
  assert.equal(depositFederation({ lobbyInvite: inviteOf(B), statuses, held: [], sameFederation }).invite, inviteOf(B));
  // a federation not known-good nor confirmed is never picked
  assert.equal(depositFederation({ lobbyInvite: inviteOf(A), statuses, held: [], known: (f) => f !== B, sameFederation }).invite, inviteOf(A));
  // nothing verified: the lobby's
  assert.equal(depositFederation({ lobbyInvite: inviteOf(A), statuses: [], held: [], sameFederation }).invite, inviteOf(A));
});

test('every deposit goes to the lowest load, a returning player\'s too (2026-10-13); the old rule only with always: false', () => {
  const statuses = [st(A, 4.3333), st(B, 0.0002)];
  assert.equal(depositFederation({ lobbyInvite: inviteOf(A), statuses, held: [A], sameFederation }).invite, inviteOf(B), 'a player holding A deposits into B, the lower load');
  assert.equal(depositFederation({ lobbyInvite: inviteOf(A), statuses, held: [B], sameFederation }).invite, inviteOf(B));
  assert.equal(depositFederation({ lobbyInvite: inviteOf(A), statuses, held: [A], sameFederation, always: false }).invite, inviteOf(A), '§23A.3\'s returning-player rule, when asked');
});

test('a withdraw reads the federation of the summed balance that holds the most', () => {
  const statuses = [st(A, 4.3333), st(B, 0.0002)];
  const got = withdrawFederation({ lobbyInvite: inviteOf(A), parts: [{ federation: A, sats: 300 }, { federation: B, sats: 900 }], statuses });
  assert.deepEqual([got.invite, got.federation, got.sats], [inviteOf(B), B, 900]);
  assert.equal(withdrawFederation({ lobbyInvite: inviteOf(A), parts: [], statuses }).invite, inviteOf(A), 'nothing read: the lobby\'s');
  assert.equal(withdrawFederation({ lobbyInvite: inviteOf(A), parts: [{ federation: C, sats: 5000 }, { federation: A, sats: 1 }], statuses }).invite, inviteOf(A), 'a federation without a verified invite is not read');
});

// AND THE PAGE USES IT: its own moneyContext (index.html), run on a lobby in federation A with B verified at a lower load
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';
test('the page\'s moneyContext hands every deposit B\'s invite, not the lobby round\'s A, a player holding A too', () => {
  const PAGE = new URL('../../../unity-proto/Assets/WebGLTemplates/NextBlock/index.html', import.meta.url);
  const HTML = readFileSync(PAGE, 'utf8');
  // depositPick (the one pick) and moneyContext, which follows it
  const a = HTML.indexOf('    function depositPick(lobbyInvite) {');
  const m = HTML.indexOf('    function moneyContext(which = \'deposit\', seatRound = null) {');
  assert.ok(a > 0 && m > a, 'depositPick comes before moneyContext');
  const slice = HTML.slice(a, HTML.indexOf('\n    }\n', m) + 7);
  const run = (held, which = 'deposit', parts = []) => {
    const fn = pageFunction(PAGE, ['window', 'BLWPCLIENT', 'walletSeed', 'moneyRound', 'vault', 'localStorage'], [slice], 'return moneyContext;');
    const window = { ARENA_LOBBY: [{ id: 'r1', free: false, raw: { contract: { stakeMsat: 100000n } } }], ARENA_LEDGER_LOBBY: { federation: inviteOf(A) },
      ARENA_FED_LOADS: new Map([[A, st(A, 4.3333)], [B, st(B, 0.0002)]]), ARENA_WALLET_BALANCE: { parts } };
    const BLWPCLIENT = { depositFederation, withdrawFederation, ledgerFederations: () => held, federationIsKnown: () => true, federationConfirmed: () => false,
      inviteNamesFederation: sameFederation, marketForRound: () => null, lobbyStakeSats: () => 100,
      fromHex: (h) => Uint8Array.from(String(h).match(/../g).map((x) => parseInt(x, 16))) };
    const ctx = fn(window, BLWPCLIENT, () => 'seed', () => null, () => ({}), {})(which);
    return { ctx, picked: window.ARENA_DEPOSIT_FEDERATION };
  };
  const first = run([]);
  assert.equal(first.ctx.ok, true);
  assert.equal(first.ctx.invite, inviteOf(B), 'a first deposit goes to B (0.0002), not the lobby round\'s A (4.33)');
  assert.equal(first.picked.federation, B);
  // and the wallet is opened under B's own id, not the lobby round's (B's invite beside A's id opened B's wallet under A's key)
  assert.equal(Buffer.from(first.ctx.round.federationId).toString('hex'), String(B).toLowerCase());
  assert.equal(run([A]).ctx.invite, inviteOf(B), 'a player already holding A deposits into B, the lower load');
  //: a withdraw with nothing held anywhere reads the federation a deposit would, under its own id - never fromHex("null")
  const empty = run([], 'withdraw', []).ctx;
  assert.equal(Buffer.from(empty.round.federationId).toString('hex'), String(B).toLowerCase());
  assert.equal(empty.invite, inviteOf(B));
  // and one holding A reads A
  const holding = run([A], 'withdraw', [{ federation: A, sats: 500 }]).ctx;
  assert.equal(Buffer.from(holding.round.federationId).toString('hex'), String(A).toLowerCase());
  assert.equal(holding.invite, inviteOf(A));
});
