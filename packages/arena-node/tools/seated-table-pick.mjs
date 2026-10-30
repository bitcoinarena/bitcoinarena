// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A TEST TOOL TAKES ONLY A ROUND OF A SEATED TABLE (kanban #803, measured 2026-10-30 07:2xZ: tn4-rps-paid took the soonest RPS round,
// one of table 24d4c900 whose first round never got a certificate; it waited out the round for one that could not come and paid
// nothing - run after run). A table's later round is taken only when the table's first round holds both certificates (GET /seating
// 200 for game and settlement); a table's first round whose seating is still to come is taken as before; a game seated per round too.
import { decodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { tableAnchorOf } from '../../arena-protocol/src/known-game.js';
import { toHex } from '../../arena-protocol/src/hash.js';

/**
 * The first of `rows` (ids hex, in the order to try) that `accept(contract)` takes and whose table is seated, with why each before it
 * was passed. `contractOf(idHex)`: the round's bytes; `seated(anchorHex, role)`: does a seat hold that certificate. Each table asked once.
 */
export async function pickSeatedTableRound(rows, { contractOf, seated, accept = () => true, limit = 40 }) {
  const tables = new Map();   // anchor hex -> seated?
  const passed = [];
  for (const id of rows.slice(0, limit)) {
    let c; try { c = decodeRoundContract(await contractOf(id)); } catch (e) { passed.push({ id, why: `no contract: ${e.message}` }); continue; }
    if (!accept(c)) { passed.push({ id, why: 'not asked for' }); continue; }
    const a = tableAnchorOf(c);
    if (a && !a.first) {
      const h = toHex(a.anchorId);
      if (!tables.has(h)) tables.set(h, (await seated(h, 'game')) && (await seated(h, 'settlement')));
      if (!tables.get(h)) { passed.push({ id, why: `table ${h.slice(0, 8)} is not seated` }); continue; }
    }
    return { id, contract: c, passed };
  }
  return { id: null, passed };
}
