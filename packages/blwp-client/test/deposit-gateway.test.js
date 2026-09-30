// THE FUNDED-GATEWAY RULE (the owner 2026-09-30 14:30: "A deposit goes only to a gateway that holds e-cash"): the choice,
// and the list carried from daily.json through the lobby link into the join link the page deposits from.
import test from 'node:test';
import assert from 'node:assert/strict';
import { depositGateway } from '../src/page-lock.js';
import { dailyLobbySearch, lobbyJoinSearch } from '../src/lobby.js';

test('the planned gateway only if listed, else the first listed; no list keeps the plan', () => {
  const B = 'https://cleaner-cindy-duty-biggest.trycloudflare.com/', A = 'https://seat.example.com:10000/';
  assert.equal(depositGateway(A, [B]), B, 'an unfunded pick went through');
  assert.equal(depositGateway(B.replace(/\/$/, ''), [B]), B);
  assert.equal(depositGateway(A, []), A);
  assert.equal(depositGateway('', [B, A]), B);
});

test('daily.json\'s gateway list reaches the join link', () => {
  const daily = { node: ['https://a.example', 'https://b.example'], bond: 'https://a.example/bond', advert: 'ab'.repeat(64),
    gateway: ['https://funded.example/', 'not a url'] };
  const search = dailyLobbySearch(daily);
  assert.ok(search, 'daily.json with a gateway list is refused');
  const join = new URLSearchParams(lobbyJoinSearch(search, 'cd'.repeat(32)).slice(1));
  assert.equal(join.get('gateway'), 'https://funded.example/');
});
