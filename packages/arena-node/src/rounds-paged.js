// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3904: THE ROUNDS AFTER A ROWID, A PAGE AT A TIME. One .all() over the rounds table held every contract at once (869,467 rows,
// 858 MB of BLOBs on a copy of a testnet4 seat) and glibc kept that heap for good. `cols` are the columns asked; the rows come in rowid
// order, ROUNDS_PAGE per statement, each page a new statement run (no read held open between pages).
export const ROUNDS_PAGE = 1024;
export function* roundsAfter(db, cols, after, { page = ROUNDS_PAGE } = {}) {
  let at = Number(after) || 0;
  for (;;) {
    const rows = db.prepare(`SELECT rowid AS rowid_3904, ${cols} FROM rounds WHERE rowid > ? ORDER BY rowid LIMIT ?`).all(at, page);
    for (const r of rows) { at = Number(r.rowid_3904); yield r; }
    if (rows.length < page) return;
  }
}
