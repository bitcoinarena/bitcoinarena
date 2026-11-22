// audit attest r3-1: A RESTARTED SEAT NEVER ATTESTS THE DRAWN MARKET ROUNDS ITS SERIES WRITER OPENED MORE THAN ~24.5 H BEFORE.
// server.js due() (the DrawnAttestor's list of rounds to sign) reads the rounds table once per row behind a rowid cursor that starts at 0
// at every start, and only rows with `opened_ms > now - DRAWN_KEEP_MS` (drawn-attestor.js KEEP_MS: one day + 30 min + 60 s, kanban #2406).
// A series round is opened by the series writer SERIES_WRITE_AHEAD_MS (72 h) before its start, and is never opened again after a restart
// (series-writer.js: "a round the store holds already is not opened again"). So after any restart (a release roll, a reboot) the seat
// leaves out of drawnContracts every drawn round whose row is older than ~24.5 h - every Up/Down round of the next ~47 h - and signs no
// word for any of them. Three of the seven drawn seats restarted (one host, or one roll) leave no 5 of 7: every round VOID for ~2 days.
// Safe: a drawn market round whose window just ended is listed as due by a seat that was restarted, whenever its row was opened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '../src/server.js';
import { openStore } from '../src/store.js';
import { DrawnAttestor, KEEP_MS } from '../src/drawn-attestor.js';
import { contractFor, b32, opts } from './window-fixture.js';
import { testNow } from './test-clock.js';
import { HOSTED } from './plugins/hosted.js';
import { testDevKey, testDonationSet } from './plugins/sign.js';
import { signManifest } from '../../arena-donor/src/manifest-sign.js';
import { gameIdOf, RESULT_TYPE, PAYOUT_RULE, NO_PARENT, isDrawnAttest } from '../../arena-protocol/src/manifest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { SERIES_WRITE_AHEAD_MS } from '../../arena-protocol/src/series.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const PERIOD = 900000n;
const HOUR = 3600000;
const dev = testDevKey('audit drawn updown');
const donationSet = testDonationSet('audit drawn updown');
const manifest = signManifest({
  gameName: 'audit-updown-drawn', gameDevPubkey: dev.pubkey, version: 1, parentManifestId: NO_PARENT, resultType: RESULT_TYPE.ATTESTED,
  cores: [], runTicksMax: 0, roundPeriodMs: PERIOD, payoutRule: PAYOUT_RULE.PARI_MUTUEL, rankNumerator: 0, rankDenominator: 0, minScore: 0,
  clients: [], gameDonationSetId: donationSetId(donationSet), outcomes: ['Up', 'Down'], attestors: [], attestThreshold: 0,
  attestDraw: { count: 7, threshold: 5 },
}, dev);
const DRAWN = Object.freeze({ name: 'audit-updown-drawn', manifest, gameId: gameIdOf(manifest), cores: new Map(), donationSet });

test('audit attest r3-1: a restarted seat lists as due a drawn round whose window just ended, though its series wrote the row 72 h ahead', async () => {
  assert.ok(isDrawnAttest(manifest), 'the test market draws its attestors');
  // WHAT THE SEAT'S DRAWN ATTESTOR IS HANDED: its due() list, read on every 10 s pass (read() kept off the network)
  const seen = new Map();
  const origRead = DrawnAttestor.prototype.read, origPass = DrawnAttestor.prototype.pass;
  DrawnAttestor.prototype.read = async function () {};
  DrawnAttestor.prototype.pass = async function () { for (const r of this.due()) seen.set(toHex(r.roundId), r); return []; };
  const path = join(mkdtempSync(join(process.env.TMPDIR || '.', 'audit-attest-r3-1-')), 'node.db');
  const db = openStore(path);
  const now = testNow();
  // a round whose 15 min window ended a minute ago (due now, until its end + 30 min)
  const close = BigInt(now - 60000) - (BigInt(now - 60000) % PERIOD);
  const base = { ...contractFor([b32(0x31), b32(0x32)], 600000n), gameId: DRAWN.gameId, simCoreHash: b32(0), configHash: b32(0), stakeMsat: 0n,
    committeeTimeMs: close - PERIOD - 600000n, startTimeMs: close - PERIOD, entryCloseMs: close };
  const old = { ...base, censusHeight: 900001 };      // its series writer opened it 72 h before its start, before the restart
  const fresh = { ...base, censusHeight: 900002 };    // control: a row opened 1 h ago
  const ins = (c, openedMs) => db.prepare('INSERT INTO rounds (round_id, contract, state, opened_ms) VALUES (?, ?, 0, ?)').run(roundId(c), encodeRoundContract(c), openedMs);
  ins(old, Number(base.startTimeMs) - Number(SERIES_WRITE_AHEAD_MS));
  ins(fresh, now - HOUR);
  // THE SEAT STARTS (a restart: the rows are in its store already)
  const a = await serve(db, { plugins: [...HOSTED, DRAWN], port: 0, ...opts });
  try {
    for (let i = 0; i < 26 && !(seen.size >= 1 && i > 12); i++) await new Promise((go) => setTimeout(go, 1000));
    const oldHex = toHex(roundId(old)), freshHex = toHex(roundId(fresh));
    console.log(`  FACTS: KEEP_MS ${KEEP_MS / HOUR} h; series write-ahead ${Number(SERIES_WRITE_AHEAD_MS) / HOUR} h; window ended ${Math.round((now - Number(close)) / 1000)} s ago;`
      + ` due after the restart: control (row 1 h old) ${seen.has(freshHex)}, series round (row ${Math.round((now - (Number(base.startTimeMs) - Number(SERIES_WRITE_AHEAD_MS))) / HOUR)} h old) ${seen.has(oldHex)}`);
    assert.ok(seen.has(freshHex), 'control: the drawn round opened 1 h ago is due (harness works)');
    assert.ok(seen.has(oldHex), 'the restarted seat never lists the series round whose row was opened 72 h ahead: it signs no word for it, and with 3 of 7 drawn seats restarted the round is VOID');
  } finally {
    DrawnAttestor.prototype.read = origRead; DrawnAttestor.prototype.pass = origPass;
    await a.close?.();
  }
});
