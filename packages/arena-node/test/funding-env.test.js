// WHICH ROUNDS AND ENTRIES A NODE PROCESS HOLDS MONEY FOR, FROM ITS OWN SETTINGS (kanban #149 step 1, plan comment 249,
// Go 2026-10-05). fundingFromEnv is what main.js hands the server: ARENA_FUNDED_ROUNDS and ARENA_FUNDED_ROUNDS_FILE name the
// paying rounds this operator funds, ARENA_FUND_FREE_ROUNDS=1 adds free rounds and their entries. The file is read at every
// ask, so a launcher that names a round after the node started is heard; nothing unnamed is funded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fundingFromEnv } from '../src/funding.js';
import { contractFor, b32 } from './window-fixture.js';
import { encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const paying = (n) => ({ ...contractFor([b32(1), b32(2)], 3000n, ['wss://r.example']), stakeMsat: 100000n, censusHeight: 900000 + n });
const free = (n) => ({ ...contractFor([b32(1), b32(2)], 3000n, ['wss://r.example']), stakeMsat: 0n, censusHeight: 800000 + n });
const idOf = (c) => toHex(roundId(c));
const round = (funded, contract) => funded({ kind: 'round', contract });
// a node that holds the given rounds (by contract), and reaches the federation or not
const nodeHolding = (contracts, reachesFederation = true) => ({
  reachesFederation,
  holds: (rid) => { const c = contracts.find((x) => idOf(x) === toHex(rid)); return c ? { contract: encodeRoundContract(c) } : null; },
});
const entry = (funded, contract, node) => funded({ kind: 'entry', contract: { roundId: roundId(contract) }, node });

test('a paying round named in ARENA_FUNDED_ROUNDS is funded; any other paying round is not', () => {
  const [a, b, c] = [paying(1), paying(2), paying(3)];
  const funded = fundingFromEnv({ ARENA_FUNDED_ROUNDS: `${idOf(a)}, ${idOf(b)}` });
  assert.equal(round(funded, a), true);
  assert.equal(round(funded, b), true);
  assert.equal(round(funded, c), false, 'an unnamed paying round');
  assert.equal(round(fundingFromEnv({}), a), false, 'no setting names nothing');
});

test('free rounds and their entries are funded only with ARENA_FUND_FREE_ROUNDS=1', () => {
  const f = free(1);
  const node = nodeHolding([f]);
  const plain = fundingFromEnv({});
  assert.equal(round(plain, f), false, 'a free round, unset');
  assert.equal(entry(plain, f, node), false, 'its entry, unset');
  const daily = fundingFromEnv({ ARENA_FUND_FREE_ROUNDS: '1' });
  assert.equal(round(daily, f), true);
  assert.equal(entry(daily, f, node), true);
  assert.equal(entry(daily, f, nodeHolding([])), false, 'an entry into a free round the node does not hold');
  assert.equal(round(fundingFromEnv({ ARENA_FUND_FREE_ROUNDS: 'yes' }), f), false, 'only "1" turns it on');
  const p = paying(4);
  assert.equal(round(daily, p), false, 'free rounds on: an unnamed paying round is still not funded');
});

test('ARENA_FUNDED_ROUNDS_FILE is read again at every ask; a missing file names none and does not throw', () => {
  const dir = mkdtempSync(join(tmpdir(), 'funded-'));
  const file = join(dir, 'funded-rounds.txt');
  const [a, b] = [paying(5), paying(6)];
  const funded = fundingFromEnv({ ARENA_FUNDED_ROUNDS_FILE: file });
  assert.equal(round(funded, a), false, 'no file yet');
  writeFileSync(file, `${idOf(a)}\n`);
  assert.equal(round(funded, a), true, 'written after the rule was built');
  assert.equal(round(funded, b), false);
  appendFileSync(file, `${idOf(b)}\n`);
  assert.equal(round(funded, b), true, 'appended later');
  writeFileSync(file, '');
  assert.equal(round(funded, a), false, 'emptied: no longer named');
  const both = fundingFromEnv({ ARENA_FUNDED_ROUNDS: idOf(a), ARENA_FUNDED_ROUNDS_FILE: file });
  writeFileSync(file, idOf(b));
  assert.equal(round(both, a) && round(both, b), true, 'the setting and the file together');
});

test('text that is not a 64-hex id names nothing; an upper-case id is read as itself', () => {
  const a = paying(7);
  const id = idOf(a);
  for (const text of [id.slice(0, 63), `${id}0`, `x${id.slice(1)}`, `round=${id}`, '', '   ,,  '])
    assert.equal(round(fundingFromEnv({ ARENA_FUNDED_ROUNDS: text }), a), false, `"${text.slice(0, 20)}..."`);
  assert.equal(round(fundingFromEnv({ ARENA_FUNDED_ROUNDS: id.toUpperCase() }), a), true);
  assert.equal(round(fundingFromEnv({ ARENA_FUNDED_ROUNDS: `junk\n\t${id}  more junk` }), a), true, 'an id among other words');
});

test('nameRound adds a round in-process, as bytes or as hex', () => {
  const [a, b] = [paying(8), paying(9)];
  const funded = fundingFromEnv({});
  funded.nameRound(roundId(a));
  funded.nameRound(idOf(b).toUpperCase());
  assert.equal(round(funded, a), true);
  assert.equal(round(funded, b), true);
});

test('a paying entry is funded only when the node holds its round and reaches the federation', () => {
  const a = paying(10);
  const funded = fundingFromEnv({ ARENA_FUNDED_ROUNDS: idOf(a) });
  assert.equal(entry(funded, a, nodeHolding([a], true)), true);
  assert.equal(entry(funded, a, nodeHolding([a], false)), false, 'no federation reached');
  assert.equal(entry(funded, a, nodeHolding([], true)), false, 'the round not held');
  assert.equal(entry(funded, a, undefined), false, 'no node');
});

test('a contract that cannot be read is not funded - false, never a throw', () => {
  const funded = fundingFromEnv({ ARENA_FUNDED_ROUNDS: '00'.repeat(32), ARENA_FUND_FREE_ROUNDS: '1' });
  assert.equal(round(funded, { stakeMsat: 'not a number' }), false);
  assert.equal(round(funded, null), false);
  assert.equal(funded({ kind: 'entry', contract: { roundId: b32(1) }, node: { holds: () => ({ contract: new Uint8Array([1, 2, 3]) }), reachesFederation: true } }), false,
    'an entry whose held round does not decode');
  assert.equal(funded({ kind: 'something else' }), false);
  assert.equal(funded(), false);
});
