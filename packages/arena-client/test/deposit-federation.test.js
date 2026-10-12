// THE FIRST DEPOSIT GOES TO THE LOWEST-LOAD FEDERATION (§23A.3, kanban #324 step 1): depositFederation over verified statuses -
// the lobby round's federation is not used when another OPEN, known one has a lower load; a returning player stays in its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { depositFederation } from '../src/federations.js';

const A = 'aa'.repeat(32), B = 'bb'.repeat(32), C = 'cc'.repeat(32);
const inviteOf = (fid) => `fed1-invite-of-${fid.slice(0, 4)}`;
const sameFederation = (inv, fid) => inv === inviteOf(fid);
const st = (federation, load, status = 'OPEN') => ({ federation, status, load, invite: inviteOf(federation) });

test('a first deposit lands on the lowest-load OPEN known federation, not the lobby round\'s when it is not the lowest', () => {
  const statuses = [st(A, 4.3333), st(B, 0.0002), st(C, 0.0001, 'DRAINING')];
  const got = depositFederation({ lobbyInvite: inviteOf(A), statuses, held: [], sameFederation });
  assert.deepEqual([got.invite, got.federation, got.lowest], [inviteOf(B), B, true]);
  assert.notEqual(got.invite, inviteOf(A), 'the lobby round\'s federation (load 4.33) is not used');
  assert.match(got.why, /first deposit: federation bbbbbbbbbbbbbbbb has the lowest load \(0\.00\)/);
  // the lobby federation is the lowest: it is used
  assert.equal(depositFederation({ lobbyInvite: inviteOf(B), statuses, held: [], sameFederation }).invite, inviteOf(B));
  // a federation not known-good nor confirmed is never picked
  assert.equal(depositFederation({ lobbyInvite: inviteOf(A), statuses, held: [], known: (f) => f !== B, sameFederation }).invite, inviteOf(A));
  // nothing verified: the lobby's
  assert.equal(depositFederation({ lobbyInvite: inviteOf(A), statuses: [], held: [], sameFederation }).invite, inviteOf(A));
});

test('a returning player stays in the federation it holds - for its deposit and its withdraw', () => {
  const statuses = [st(A, 4.3333), st(B, 0.0002)];
  const inB = depositFederation({ lobbyInvite: inviteOf(A), statuses, held: [B], sameFederation });
  assert.deepEqual([inB.invite, inB.lowest], [inviteOf(B), false]);
  const inA = depositFederation({ lobbyInvite: inviteOf(A), statuses, held: [A], sameFederation });
  assert.equal(inA.invite, inviteOf(A), 'a player holding the lobby federation is not moved by a deposit');
});

// AND THE PAGE USES IT: its own moneyContext (index.html), run on a lobby in federation A with B verified at a lower load
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';
test('the page\'s moneyContext hands a first deposit B\'s invite, not the lobby round\'s A; a returning player in A keeps A', () => {
  const PAGE = new URL('../../../unity-proto/Assets/WebGLTemplates/NextBlock/index.html', import.meta.url);
  const HTML = readFileSync(PAGE, 'utf8');
  const a = HTML.indexOf('    function moneyContext() {');
  const slice = HTML.slice(a, HTML.indexOf('\n    }\n', a) + 7);
  const run = (held) => {
    const fn = pageFunction(PAGE, ['window', 'BLWPCLIENT', 'walletSeed', 'moneyRound', 'vault', 'localStorage'], [slice], 'return moneyContext;');
    const window = { BLWP_LOBBY: [{ id: 'r1', free: false, raw: { contract: { stakeMsat: 100000n } } }], BLWP_LEDGER_LOBBY: { federation: inviteOf(A) },
      ARENA_FED_LOADS: new Map([[A, st(A, 4.3333)], [B, st(B, 0.0002)]]) };
    const BLWPCLIENT = { depositFederation, ledgerFederations: () => held, federationIsKnown: () => true, federationConfirmed: () => false,
      inviteNamesFederation: sameFederation, marketForRound: () => null, lobbyStakeSats: () => 100 };
    const ctx = fn(window, BLWPCLIENT, () => 'seed', () => null, () => ({}), {})();
    return { ctx, picked: window.ARENA_DEPOSIT_FEDERATION };
  };
  const first = run([]);
  assert.equal(first.ctx.ok, true);
  assert.equal(first.ctx.invite, inviteOf(B), 'a first deposit goes to B (0.0002), not the lobby round\'s A (4.33)');
  assert.equal(first.picked.federation, B);
  assert.equal(run([A]).ctx.invite, inviteOf(A), 'a player already holding A stays in A');
});
