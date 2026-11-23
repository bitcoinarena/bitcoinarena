// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 state machine audit (federation), round 11: A FEDERATION THAT HALTS PINS THE WITHDRAW ON ITSELF.
// FEDERATION_ALLOWS says HALTED: withdraw false (its notes are frozen until it recovers or is liquidated). withdrawFederation - the one
// pick of the page's Withdraw (index.html moneyContext('withdraw')) - takes the federation of the summed balance holding the most among
// those whose verified status names an invite, whatever that status is. A federation that turns HALTED while it holds the player's larger
// part keeps being the Withdraw's federation: every withdraw is tried against frozen notes (a send that never completes), and the money
// the player holds in an OPEN federation cannot leave through the Withdraw at all until the halted one's notes are gone.
// Safe behaviour: the Withdraw reads only a federation whose status allows a withdraw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withdrawFederation, FEDERATION_ALLOWS } from '../src/federations.js';

const H = 'aa'.repeat(32), O = 'bb'.repeat(32);
const inviteOf = (fid) => `fed1-invite-of-${fid.slice(0, 4)}`;
const st = (federation, status) => ({ federation, status, allows: FEDERATION_ALLOWS[status], load: 0.2, invite: inviteOf(federation) });

test('wf1489-sm1-federation-3 (#2434): the Withdraw never picks a HALTED federation while an OPEN one holds the player\'s money', () => {
  assert.equal(FEDERATION_ALLOWS.HALTED.withdraw, false);
  const statuses = [st(H, 'HALTED'), st(O, 'OPEN')];
  const got = withdrawFederation({ lobbyInvite: inviteOf(O), parts: [{ federation: H, sats: 9000 }, { federation: O, sats: 4000 }], statuses });
  assert.notEqual(got.federation, H, `the Withdraw reads the HALTED federation ${H.slice(0, 8)} (withdraw not allowed), the OPEN one's 4000 sat cannot leave`);
  assert.equal(got.federation, O);
});

// The page's own check (index.html openMoney): a Withdraw asks the withdraw-from federation's status, not the lobby federation's.
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';
import { federationSays } from '../src/federations.js';
import { ArenaText, ArenaBits } from './arena-text.js';

const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
const HTML = readFileSync(PAGE, 'utf8');
const slice = (from, to) => { const a = HTML.indexOf(from); assert.ok(a > 0, from.slice(0, 40)); return HTML.slice(a, HTML.indexOf(to, a) + to.length); };
const OPEN = slice('    function openMoney(which, say = ', '\n      })();\n    }\n');
function openMoneyWith(lobbyStatus, withdrawFrom) {
  const els = {}; const el = (id) => (els[id] = els[id] || { id, textContent: '', style: {} });
  for (const id of ['arena-fed-note', 'arena-money-why', 'arena-settings']) el(id);
  const document = { getElementById: (id) => els[id] || null, body: { classList: { toggle: () => {}, contains: () => false } } };
  const window = { ArenaText, ArenaBits, ARENA_TRACK: () => {}, ARENA_FED_STATUS: st(H, lobbyStatus), ARENA_FED_LOADS: new Map([[H, st(H, lobbyStatus)], [O, st(O, 'OPEN')]]) };
  const did = [];
  const ARENACLIENT = { federationSays, depositDonationMsat: () => 0n, marketForRound: () => null };
  const fn = pageFunction(PAGE, ['document', 'window', 'ARENACLIENT', 'moneyContext', 'openWithdraw', 'showDepositOffer', 'depositWait', 'donationBps', 'vault'],
    [OPEN], 'return { openMoney };');
  const api = fn(document, window, ARENACLIENT, () => ({ ok: true, round: { stakeMsat: 1n }, invite: inviteOf(withdrawFrom), seed: 's', gateways: [], withdrawFrom: { federation: withdrawFrom, invite: inviteOf(withdrawFrom), sats: 4000 } }),
    () => did.push('withdraw'), () => {}, () => null, () => 0, () => ({}));
  return { ...api, did };
}

test('wf1489-sm1-federation-3 (#2434): a HALTED lobby federation does not refuse a Withdraw from the OPEN federation that holds the money', async () => {
  const p = openMoneyWith('HALTED', O);
  assert.deepEqual(await p.openMoney('withdraw', () => {}), { ok: true });
  assert.ok(p.did.includes('withdraw'));
  const q = openMoneyWith('HALTED', H);   // withdrawing from the halted one itself is still refused by name
  assert.deepEqual(await q.openMoney('withdraw', () => {}), { ok: false, why: federationSays('HALTED') });
});
