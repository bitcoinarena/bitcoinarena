// A FAILED WITHDRAW KEEPS ITS WARNING (kanban #200, comment 574): lookRound (b8e0b064) looks at a round through the player
// wallet while arena.tabempty.<round> says the round's own wallet was read empty - and a zero read that way is not proof it
// is empty. Withdraw collects INTO the round's wallet and then pays; when the pay fails the ecash stays there. index.html's
// BLWP_WITHDRAW and lookRound run under the page's name (page-script.js) with fake wallets; the warning is page-lock.js's
// own owedToLine. Measured: after a failed pay - or a pay that throws - the note is gone, the next load's lookRound joins
// the round's wallet, reads the ecash and the warning says it; a later Withdraw still finds it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';
import { owedToLine } from '../src/page-lock.js';

const PAGE = new URL('../../../unity-proto/Assets/WebGLTemplates/BtcLogistics/index.html', import.meta.url);
const HTML = readFileSync(PAGE, 'utf8');
const cut = (from, to) => { const a = HTML.indexOf(from); assert.ok(a > 0, `index.html holds ${from.slice(0, 50)}`); return HTML.slice(a, HTML.indexOf(to, a) + to.length); };
const LOOK = cut("    const TAB_EMPTY = 'arena.tabempty.';", '\n      return { look, held: true, LockClient: w.LockClient };\n    }\n');
const WITHDRAW = cut('    window.BLWP_WITHDRAW = async function (invoice) {', '\n    };\n');

const FED = 'ab'.repeat(32), RID = 'cd'.repeat(32);
const round = { roundIdHex: RID, round: { federationId: FED } };
const WARNING = /98000 msat is in this tab's wallet - withdraw it before you close the tab/;

/** One page load over a browser's store: the round's wallet (its ecash kept across loads), the player wallet open. */
function load(store, roundWalletState, { collect } = {}) {
  const vault = () => ({ getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) });
  const joins = []; const collects = [];
  const roundClient = { lockStatus: async () => '{"stored":null}', withdrawableMsat: async () => String(roundWalletState.ecash) };
  const player = { lockStatus: async () => '{"stored":null}', withdrawableMsat: async () => '5000000' };
  const window = { BLWP_WALLET_WARM: Promise.resolve(player), BLWP_WALLET_FEDERATION: FED, BLWP_LOCK_WASM: async () => ({ LockClient: 'LC' }) };
  const lookOwed = async ({ client }) => ({ payout: { state: 'waiting' }, stake: { state: 'waiting' }, payoutMsat: 0n, stakeMsat: 0n, refundMsat: 0n,
    owedMsat: 0n, final: false, settled: false,
    inTabMsat: client !== player && typeof client.withdrawableMsat === 'function' ? BigInt(await client.withdrawableMsat()) : 0n });
  const BLWPCLIENT = { toHex: (x) => x, lookOwed, withdrawLine: () => '',
    collectAndWithdraw: async (a) => { collects.push(BigInt(await a.client.withdrawableMsat())); return collect(roundWalletState); },
    withdrawPlayerWallet: async () => ({ ok: false, why: 'nothing in the player wallet to withdraw' }) };
  const roundWallet = async () => { joins.push(1); return { LockClient: 'LC', client: roundClient }; };
  const page = pageFunction(PAGE, ['vault', 'window', 'BLWPCLIENT', 'roundAsk', 'roundWallet', 'newestKept', 'wallet', 'paintWallet', 'payoutAsking', 'performance'],
    [LOOK, WITHDRAW], 'return { lookRound, withdraw: window.BLWP_WITHDRAW };')(
    vault, window, BLWPCLIENT, () => ({}), roundWallet, () => round, null, () => {}, false, { now: () => 6000 });
  return { ...page, window, joins, collects };
}
// the pay fails after the collect: the round's wallet keeps what was collected
const failedPay = (st) => { st.ecash = 98000n; return { withdraw: { ok: false, final: false, why: 'the invoice could not be paid' } }; };

test('a failed pay leaves no empty note: the next load joins the round\'s wallet and the warning says what is in it', async () => {
  const store = new Map([['arena.tabempty.' + RID, '1']]);   // an earlier load read the round's wallet empty
  const st = { ecash: 0n };
  const first = load(store, st, { collect: failedPay });
  const said = await first.withdraw('lnbc1pasted');
  assert.equal(said.ok, false);
  assert.equal(first.window.BLWP_WITHDRAWABLE, 98000n, 'Withdraw\'s last look reads the ecash left in the round\'s wallet');
  assert.equal(store.has('arena.tabempty.' + RID), false, 'the empty note is gone');
  const next = load(store, st);
  const { look } = await next.lookRound(round);
  assert.equal(next.joins.length, 1, 'the next load joins the round\'s wallet');
  assert.equal(look.inTabMsat, 98000n);
  assert.match(owedToLine(look), WARNING);
  assert.equal(store.has('arena.tabempty.' + RID), false, 'read non-empty, no note is written');
});

test('the hole it closes: with the note left set, the look through the player wallet reads 0 and the warning is gone', async () => {
  const store = new Map([['arena.tabempty.' + RID, '1']]);
  const st = { ecash: 98000n };
  const next = load(store, st);
  const { look } = await next.lookRound(round);
  assert.equal(next.joins.length, 0);
  assert.equal(look.inTabMsat, 0n, 'a zero read through the player wallet');
  assert.doesNotMatch(owedToLine(look), WARNING);
});

test('a pay that throws before the last look: the note was dropped before the collect, so the next load still finds the ecash', async () => {
  const store = new Map([['arena.tabempty.' + RID, '1']]);
  const st = { ecash: 0n };
  const first = load(store, st, { collect: (s) => { s.ecash = 98000n; throw new Error('the gateway hung up'); } });
  await assert.rejects(first.withdraw('lnbc1pasted'), /the gateway hung up/);
  assert.equal(store.has('arena.tabempty.' + RID), false);
  const { look } = await load(store, st).lookRound(round);
  assert.match(owedToLine(look), WARNING);
});

test('the money is not lost: a later Withdraw collects from the round\'s wallet holding it', async () => {
  const store = new Map();
  const st = { ecash: 0n };
  await load(store, st, { collect: failedPay }).withdraw('lnbc1pasted');
  const later = load(store, st, { collect: (s) => { s.ecash = 0n; return { withdraw: { ok: true, final: true } }; } });
  const said = await later.withdraw('lnbc1second');
  assert.equal(said.ok, true);
  assert.deepEqual(later.collects, [98000n], 'the second Withdraw\'s wallet held the 98000 msat when it paid');
});
