// Audit client r2 (a5-2-1): the leaderboard's zap target comes from the one seat that answers GET /season first.
// The page's zap button (index.html onZap -> ARENA_ZAP.open({ recipient: r.player, name: r.name }) -> zapPlayer) pays
// e-cash to the row's `player` key. fetchSeason races 4 seats (race: 4, Promise.any) and takes the first answer whole,
// so one seat that answers fast decides which key stands under an honest player's name. SAFE: a row's key under a name
// is not taken from one seat against the others (or the board is refused), so a zap to "Satoshi" never pays another key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchSeason } from '../src/season-view.js';

const key = (n) => n.toString(16).padStart(2, '0').repeat(32);
const HONEST = key(0x5a), ATTACKER = key(0xee);
const row = (player) => ({ rank: 1, player, name: 'Satoshi', rounds: 40, wins: 30, netMsat: '900000', bestScore: 8304450 });
const board = (player) => ({ node: key(0x01), game: { name: 'nextblock', ids: [key(0x0a)] }, days: 7, rows: [row(player)],
  rounds: 41, leftOut: 0, scope: 'network', agree: 3, seats: { asked: 3, answered: 3 } });

test('one fast seat does not decide which key a zap to the board\'s top player pays', async () => {
  const seats = ['https://liar.example', 'https://a.example', 'https://b.example', 'https://c.example'];
  const fetch = async (url) => {
    const liar = url.startsWith('https://liar.example');
    if (!liar) await new Promise((r) => setTimeout(r, 50));   // honest seats answer a little later
    return new Response(JSON.stringify(board(liar ? ATTACKER : HONEST)), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const v = await fetchSeason({ nodes: seats, game: 'nextblock', days: 7, fetch, race: 4 });
  // the page hands r.player of the row it draws to zapPlayer
  const top = v.ok ? v.rows.find((r) => r.name === 'Satoshi') : null;
  assert.ok(!top || top.player === HONEST,
    `the zap to "Satoshi" pays ${top && top.player.slice(0, 8)}…, the key one seat of four named, while three seats name ${HONEST.slice(0, 8)}…`);
});
