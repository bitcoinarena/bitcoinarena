// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER AREA'S ROUNDS (kanban #715, the owner 2026-10-26: "a Rounds section which shows which rounds this node is scheduled for
// Verify/Settlement. If there are no rounds, explain in plain words why that is not the case. In Roles, Verify is 'Play and check rounds',
// and 'Settlement' is 'Pay out winners'"). GET /owner/rounds answers what roundsForOwner makes of the rounds this seat holds and the node's
// own census row: each round it is drawn for, with what it does there, and - when there is none - the first reason that holds:
//
//   not in the census     its bond does not count yet (unconfirmed, not matured, or stepped out with serving = false)
//   no round role         "Play and check rounds" and "Pay out winners" are both off
//   no game announced     its announcement names none of the games the recent rounds are for (the 2026-10-27 case: the seats loaded
//                         Up/Down v24 and never announced it, so no v24 round drew them)
//   not drawn             it is in every draw it can be in, and the lottery picked others - with its share of the bonds as the odds
//   no rounds             no round was posted in the last day
//   no rounds held        this node holds no round at all (kanban #757): it has not fetched the network's series yet
//
// Pure: the seat hands in the rows and the census row (server.js, GET /owner/rounds).

const DAY_MS = 24 * 3600 * 1000;

/** What the node does in a round, in the owner area's words (RolesPanel): "Play and check rounds", "Pay out winners", or a reserve. */
export function dutyOf(r) {
  const does = [];
  if (r.gameSeated) does.push('Play and check');
  if (r.settleSeated) does.push('Pay out winners');
  if (!does.length && r.drawn) does.push('Reserve (drawn, not seated)');
  return does;
}

/**
 * `rows` the rounds this seat holds, newest first: [{ round, game: { name, title, version }, startMs, endMs, phase, gameSeated,
 * settleSeated, drawn, hostedHere }] (`hostedHere`: this node's announcement names the round's game); `own` the node's census row at the
 * newest round, or null: { roles, serving, bondSats }; `share` its share of the census's bonds (0..1) or null; `nowMs`.
 * Answers { rounds: [...the ones it is drawn for, with `does`], upcoming, why: null | { kind, says } }.
 */
export function roundsForOwner({ rows = [], own = null, share = null, nowMs = Date.now() }) {
  const recent = rows.filter((r) => Number(r.startMs) >= nowMs - DAY_MS);
  const mine = rows.filter((r) => r.gameSeated || r.settleSeated || r.drawn).map((r) => ({ ...r, does: dutyOf(r) }));
  const upcoming = mine.filter((r) => Number(r.endMs) > nowMs).length;
  if (mine.some((r) => Number(r.startMs) >= nowMs - DAY_MS)) return { rounds: mine, upcoming, why: null };
  const said = (kind, says) => ({ rounds: mine, upcoming, why: { kind, says } });
  // NO ROUND HELD AT ALL (kanban #757, the owner's installed node b36828fa on 2026-10-28: drawn in 67 rounds, holding none, and the section
  // said its bond did not count - its census row is read from the rounds it holds, so with none there is no row to read)
  if (!rows.length && !own) return said('no rounds held', 'Your node holds none of the network\'s rounds yet, so it can\'t tell which ones draw it. It fetches the day\'s rounds from other nodes every few minutes, once their publication is confirmed on its own chain.');
  if (!own) return said('not in the census', 'Your node\'s bond doesn\'t count yet, so no round can draw it. A bond counts once it is confirmed and matured; check Bond for its state.');
  if (own.serving === false) return said('not in the census', 'Your node stepped out of the draw (serving = false). Turn it back on in Bond to be drawn again.');
  const roles = own.roles || [];
  if (!roles.includes('verify') && !roles.includes('game') && !roles.includes('settlement'))
    return said('no round role', '"Play and check rounds" and "Pay out winners" are both off, so your node is never drawn for a round. Turn one on in Roles.');
  if (!recent.length) return said('no rounds', 'No round was posted in the last day, so there was nothing to draw your node for.');
  if (!recent.some((r) => r.hostedHere)) {
    const games = [...new Set(recent.map((r) => (r.game ? `${r.game.title || r.game.name}${r.game.version ? ` v${r.game.version}` : ''}` : null)).filter(Boolean))].slice(0, 3);
    return said('no game announced', `Your node's announcement doesn't name the games today's rounds are for (${games.join(', ')}), so those rounds can't draw it. An update of its announcement fixes this; the node does it after every update of its apps.`);
  }
  const odds = typeof share === 'number' && share > 0 ? ` With ${(share * 100).toFixed(1)} % of all bonds it is picked for about ${Math.max(1, Math.round(share * 7 * 100))} of every 100 rounds.` : '';
  return said('not drawn', `Your node was in the draw for ${recent.filter((r) => r.hostedHere).length} rounds of the last day and the lottery picked other nodes.${odds}`);
}
