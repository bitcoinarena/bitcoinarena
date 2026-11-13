// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Adapted to 1.9 by #2536 (kanban #1947): the first test runs unchanged (1.9's #1585 walletKey keys the wallet by round AND phrase); the second tested the card's own forgetRoundWallets and a lock per phrase, which 1.9 does not have (its browser lock stays per round by design) - not kept.
// WF1489 SM4 PAGE-3: ONE ROUND WALLET PER ROUND IN A TAB, WHATEVER PHRASE THE RECORD IS - another phrase's record is looked at, and closed,
// with this phrase's round wallet.
// SM-T2: index.html roundWallet caches the round's lock wallet in `roundWallets` by round id alone, and the wallet is the phrase's AND the
// round's (arena.lockdb.<round16>.<sha(lockSecretFor(seed, round))16>). Two phrases of one browser in one round (two tabs, two players) leave
// two records of that round; the tab that collects both (its own, and the other phrase's once that tab closed - withRecordPhrase) opens the
// first record's wallet and hands it to the second record's look: lookOwed reads the OTHER wallet's balance as this record's inTabMsat.
// Phrase B's round wallet holding e-cash (an older build's, or a withdraw that failed after its collect) is read 0 through phrase A's, the record
// is marked done with tabMsat '0' (collectState), and an hour later tidyStorage removes phrase B's round wallet with its e-cash in it.
// The tab empty note (arena.tabempty.<round>) is written from the same wrong read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';
import * as PL from '../src/page-lock.js';

const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
const HTML = readFileSync(PAGE, 'utf8');
const from = HTML.indexOf('    const heldRounds = new Set();');
const end = HTML.indexOf('\n    }\n', HTML.indexOf('async function lookRound', from)) + '\n    }\n'.length;
assert.ok(from > 0 && end > from, 'index.html holds holdRound, roundWallet and lookRound');
const SRC = HTML.slice(from, end);

const hex = (n) => n.toString(16).padStart(2, '0').repeat(32);
const FED = hex(0xab), RID = hex(0xcd), SEED_A = hex(0x11), SEED_B = hex(0x22);
const fromHex = (h) => Uint8Array.from(Buffer.from(h, 'hex'));

test('wf1489-sm4-page-3: a record of phrase B is looked at with phrase B\'s round wallet, not with the one phrase A\'s record opened in the same round', async () => {
  const store = new Map();
  const vault = () => ({ get length() { return store.size; }, key: (i) => [...store.keys()][i] ?? null, getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) });
  // each phrase's round wallet: A's empty, B's holding 7000 msat of e-cash
  const inWallet = { [SEED_A]: 0n, [SEED_B]: 7000n };
  const opened = [];
  const ARENACLIENT = {
    toHex: (x) => (typeof x === 'string' ? x : Buffer.from(x).toString('hex')),
    tabLockWallet: async (ask) => { opened.push(ask.seed); return { seed: ask.seed, lockStatus: async () => '{"stored":null}', withdrawableMsat: async () => String(inWallet[ask.seed]) }; },
    lookOwed: async (a) => ({ payout: { state: 'none' }, stake: { state: 'none' }, owedMsat: 0n, final: true, inTabMsat: BigInt(await a.client.withdrawableMsat()), lookedSeed: a.seed }),
  };
  const window = { ARENA_LOCK_WASM: async () => ({ LockClient: 'LC', default: async () => {} }) };
  const roundAsk = (r, LockClient) => ({ seed: r.seed, roundId: r.roundIdHex, LockClient });
  const lookRound = pageFunction(PAGE, ['navigator', 'window', 'ARENACLIENT', 'roundAsk', 'roundWallets', 'vault', 'performance'], SRC, 'return lookRound;')(
    {}, window, ARENACLIENT, roundAsk, new Map(), vault, { now: () => 60000 });
  const recA = { roundIdHex: RID, round: { federationId: FED }, seed: SEED_A, own: true };
  const recB = { roundIdHex: RID, round: { federationId: FED }, seed: SEED_B, own: false };
  const a = await lookRound(recA);
  store.delete('arena.tabempty.' + RID);   // even with no empty note in the way: B's look joins "the round's wallet"
  const b = await lookRound(recB);
  const stateB = PL.collectState(b.look, null);
  // what the collect then writes and what tidyStorage then does with phrase B's round wallet
  const L = vault();
  const lockdbB = PL.lockStoreFor(L, fromHex(RID), PL.lockSecretFor(fromHex(SEED_B), fromHex(RID)));
  lockdbB.put('aa', 'bb'.repeat(8));
  const hourAgo = Date.now() - 2 * 3600000;
  L.setItem(`arena.collect.${RID}.${SEED_B.slice(0, 16)}`, JSON.stringify({ roundIdHex: RID, seed: SEED_B, savedMs: hourAgo, done: stateB.state === 'done' ? { payout: 'x', stake: null, tabMsat: '0' } : null }));
  const lockdbKeysBefore = [...store.keys()].filter((k) => k.startsWith('arena.lockdb.')).length;
  PL.tidyStorage(L, { seeds: [SEED_A, SEED_B], current: SEED_A, federations: [FED] });
  const lockdbKeysAfter = [...store.keys()].filter((k) => k.startsWith('arena.lockdb.')).length;
  const facts = { opened: opened.map((s) => s.slice(0, 4)), lookAInTab: String(a.look.inTabMsat), lookBInTab: String(b.look.inTabMsat), phraseBWalletHolds: String(inWallet[SEED_B]),
    recordB: stateB.state, phraseBLockdbKeys: `${lockdbKeysBefore} -> ${lockdbKeysAfter}` };
  console.log('  FACTS wf1489-sm4-page-3:', JSON.stringify(facts));
  assert.deepEqual(opened, [SEED_A, SEED_B], `phrase B's record was looked at with phrase A's round wallet (opened: ${JSON.stringify(facts.opened)})`);
  assert.equal(b.look.inTabMsat, 7000n, `phrase B's round wallet holds 7000 msat and its record read ${facts.lookBInTab}: marked ${stateB.state}, its wallet tidied away (${facts.phraseBLockdbKeys} keys)`);
});

// kanban #1947 (the fix): the round's Web Lock is the phrase's too, and another phrase's round lock and wallet go when this tab lets that phrase go
