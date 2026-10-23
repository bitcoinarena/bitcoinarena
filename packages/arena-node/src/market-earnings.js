// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHAT A SEAT EARNED IN THE MARKETS (kanban #600: the health page showed Bitcoin Up or Down at 0 sat earned by the nodes, though every fill
// pays the round's sitting seats their part of the fee). A market round has no player results of this node, so dashboard.js's round fees
// leave it out; its node fee is the book settlement's: one `signer node` payout to each sitting seat's payout key (lock-settlement.js
// bookLockSettlement). Each round settled ACCEPTED is looked at once - its plan rebuilt (settlements.summaryOf, the cost of a /settled
// answer) - and what it paid this seat kept in market_earnings, so a restart does not rebuild it again. A round that is no market is kept
// as such (game NULL) and never looked at again. At most `perPass` plans a pass.
export function createMarketEarnings({ db, marketOf, summaryOf, ownPayoutHex, perPass = 8 }) {
  db.exec(`CREATE TABLE IF NOT EXISTS market_earnings (
    round_id BLOB PRIMARY KEY,
    game     BLOB,
    msat     TEXT,
    made_ms  INTEGER NOT NULL
  )`);
  const waiting = db.prepare(`SELECT s.round_id, s.made_ms FROM lock_settlements s LEFT JOIN market_earnings m ON m.round_id = s.round_id
    WHERE s.state = 'ACCEPTED' AND m.round_id IS NULL ORDER BY s.made_ms DESC LIMIT 400`);
  const keep = db.prepare('INSERT OR REPLACE INTO market_earnings (round_id, game, msat, made_ms) VALUES (?, ?, ?, ?)');
  const kept = db.prepare('SELECT round_id, game, msat, made_ms FROM market_earnings WHERE game IS NOT NULL AND msat IS NOT NULL');
  const me = String(ownPayoutHex).toLowerCase();
  let running = false;
  return {
    /** One pass: the newest settled rounds not looked at yet. Answers how many plans it read and kept. */
    async pass() {
      if (running) return { read: 0, kept: 0 };
      running = true;
      let read = 0, kept = 0;
      try {
        for (const r of waiting.all()) {
          const rid = new Uint8Array(r.round_id);
          const m = marketOf(rid);
          if (!m) { keep.run(r.round_id, null, null, Number(r.made_ms)); continue; }
          if (read >= perPass) continue;
          read++;
          let s = null;
          try { s = await summaryOf(rid); } catch { s = null; }
          if (!s || !Array.isArray(s.payouts)) continue;   // looked at again on a later pass
          const msat = s.payouts.filter((p) => p.kind === 'signer node' && String(p.pk).toLowerCase() === me).reduce((t, p) => t + BigInt(p.msat), 0n);
          keep.run(r.round_id, Buffer.from(m.gameId), String(msat), Number(r.made_ms)); kept++;
        }
      } finally { running = false; }
      return { read, kept };
    },
    /** Every market round this seat was paid in: [{ round, game, msat, madeMs }] (msat a BigInt). */
    rows: () => kept.all().map((x) => ({ round: Buffer.from(x.round_id).toString('hex'), game: Buffer.from(x.game).toString('hex'), msat: BigInt(x.msat), madeMs: Number(x.made_ms) })),
  };
}
