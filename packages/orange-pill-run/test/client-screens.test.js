// kanban #3251, #3265: the intro's and result's lines, the Play button's reasons, the signed calls and the entry paid in the background.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { introModel, resultModel, entryLine, myBest, fmtLeft } from "../client/src/screens.js";
import { makeApi } from "../client/src/api.js";
import { createEntry, entryOf, attemptOf } from "../client/src/entry.js";
import { RULES } from "../client/src/rules.js";

const T0 = Date.parse("2026-11-23T10:00:00Z");
const round = (o = {}) => ({ id: "2026-11-23", number: 1, test: false, phase: "open", startMs: Date.parse("2026-11-23T00:00:00Z"), endMs: Date.parse("2026-11-24T00:00:00Z"),
  entrySats: 100, maxAttempts: 5, split: [50, 30, 20], potSats: 1200, bountySats: 2000, best: { score: 1234, timeS: 41.25, name: "alice" }, ...o });
const me = (o = {}) => ({ ok: true, name: "bob", used: 2, maxAttempts: 5, x: null, placed: false, attempts: [
  { attempt: "a1", state: "scored", score: { total: 700, timeS: 50 } }, { attempt: "a2", state: "scored", score: { total: 980, timeS: 44 } }], ...o });
const board = [{ rank: 1, name: "alice", score: 1234, timeS: 41.25 }, { rank: 4, name: "bob", score: 980, timeS: 44 }];
const W = (o = {}) => ({ pubkey: "ab".repeat(32), balance: { sats: 3000 }, welcomeComing: false, ...o });

test("#3251 the intro: one line, bounty, best, pot and split, attempts, own best and rank, time left, the Play label", () => {
  const m = introModel({ round: round(), me: me(), board, wallet: W(), nowMs: T0 });
  assert.equal(m.line, "Run yesterday's Bitcoin chart. Tap to jump. Don't fall.");
  assert.equal(m.bounty, "Play bounty: 2,000 sats today for rank 1");
  assert.equal(m.best, "1,234 in 41.3 s by alice");
  assert.equal(m.pot, "1,200 testnet sats · split 50 / 30 / 20");
  assert.equal(m.attempts, "Your attempts: 2 of 5");
  assert.equal(m.mine, "Your best: 980 · rank 4");
  assert.equal(m.left, "Time left: 14 h 0 min");
  assert.deepEqual(m.button, { label: "Play · 100 testnet sats", disabled: false, why: "" });
  assert.equal(m.facts.length, 5);
});

test("#3251 the Play button is off with a reason: 5 attempts used, last 5 minutes, balance too low, not open", () => {
  const off = (o) => introModel({ nowMs: T0, round: round(), me: me(), board, wallet: W(), ...o }).button;
  assert.deepEqual(off({ me: me({ used: 5 }) }), { label: "Play · 100 testnet sats", disabled: true, why: "All 5 attempts of this round are used." });
  assert.equal(off({ round: round({ phase: "last-call" }) }).why, "No new attempts in the last 5 minutes of a round.");
  assert.equal(off({ wallet: W({ balance: { sats: 40 } }) }).why, "Your balance is too low: an attempt costs 100 testnet sats.");
  assert.equal(off({ round: round({ phase: "posting" }) }).disabled, true);
  assert.equal(off({ round: round({ phase: "ended" }) }).why, "This round has ended.");
  assert.equal(off({ round: null }).disabled, true);
  assert.equal(off({ wallet: W({ pubkey: null }) }).why, "Your Arena wallet is opening …");
});

test("#3265 a new, empty wallet whose welcome is on its way may play at once", () => {
  const b = introModel({ nowMs: T0, round: round(), me: me({ used: 0, attempts: [] }), board, wallet: W({ balance: { sats: 0 }, welcomeComing: true }) }).button;
  assert.equal(b.disabled, false);
  assert.match(b.why, /welcome sats are on their way/);
  const b2 = introModel({ nowMs: T0, round: round(), me: null, board, wallet: W({ balance: null, welcomeComing: true }) }).button;
  assert.equal(b2.disabled, false);
});

test("#3251 no Arena around the game: practice only", () => {
  const m = introModel({ round: null, me: null, board: [], wallet: null, nowMs: T0 });
  assert.equal(m.practice, true);
  assert.equal(m.button.disabled, false);
});

test("#3251 the result: breakdown, rank after, beat best, attempts left, the X prompt; #3265 the entry line", () => {
  const res = { finished: true, timeS: 40.5, total: 1100, clean: true, parts: { sats: 300, stomps: 50, goal: 500, time: 40, high: 50 } };
  const r = resultModel({ res, parTime: 60, entry: "paid", before: { total: 980 }, after: { total: 1100, rank: 2 }, me: me({ used: 3 }), max: 5 });
  assert.equal(r.title, "Flag reached in 40.5 s");
  assert.deepEqual(r.entry, { kind: "ok", text: "Entry paid - this run counts." });
  assert.equal(r.rank, "Rank 2 after this run");
  assert.equal(r.beat, "New best - you beat your 980");
  assert.equal(r.left, "Attempts left: 2 of 5");
  assert.equal(r.xPrompt, "Link your X account to be placed and win.");
  assert.equal(r.rows.at(-1)[1], "×1.5");
  assert.deepEqual(r.rows[3], ["Time bonus (20 per second under 60 s)", 40]);   // #3271 opr-2
  assert.equal(resultModel({ res, parTime: 38, timePerS: 2, entry: "paid", me: me() }).rows[3][0], "Time bonus (2 per second under 38 s)");
  const r2 = resultModel({ res: { ...res, total: 500 }, parTime: 60, entry: "waiting", before: { total: 980 }, after: { total: 980, rank: 4 }, me: me({ x: { username: "bob" }, placed: true }) });
  assert.equal(r2.beat, "Your best stays 980");
  assert.equal(r2.xPrompt, undefined);
  assert.equal(entryLine("waiting").text, "Waiting for your entry - the run counts once the 100 sats are paid.");
  assert.equal(entryLine("not-paid").text, "Entry not paid - this run does not count.");
});

test("#3251 own best and rank from GET /me and the board; time left words", () => {
  assert.deepEqual(myBest(me(), board), { total: 980, timeS: 44, attempt: "a2", rank: 4 });
  assert.equal(myBest(me({ attempts: [] }), board), null);
  assert.equal(fmtLeft(250000), "4 min 10 s");
});

test("#3251 the rules carry the card's four sentences word for word", () => {
  const all = RULES.map((r) => r[1]).join("\n");
  for (const s of ["Humans only. Bots, scripts, automated or assisted play are excluded.",
    "Any exploit or cheat disqualifies: changing the game or its data, more than one account, playing for someone else, abusing a bug instead of reporting it. Found a bug? Report it in the bug bounty.",
    "We review the top runs. Every payout is checked and approved by us before it is sent. Our decision is final.",
    "Testnet sats have no value. The play bounty is paid in real sats and can end or change at any time."]) assert.ok(all.includes(s), s);
  assert.match(RULES.find((r) => r[0] === "Speed")[1], /Faster finishes score much more: 20 points for every second under/);   // #3271
  for (const k of ["Round", "Level", "Entry", "Attempts", "Score", "Speed", "Tie-break", "Pot", "Play bounty", "X account"]) assert.ok(RULES.some((r) => r[0] === k), k);
});

test("#3265 the sign-in names the stage URL without the query, the method and the body's hash", async () => {
  const seen = [];
  const bridge = { signHttpAuth: async (tags) => ({ kind: 27235, tags, pubkey: "p" }) };
  const api = makeApi({ base: "http://127.0.0.1:1/api/opr", signBase: "https://testnet-stage.bitcoinarena.io/api/opr", bridge,
    fetch: async (u, o) => { seen.push({ u, o }); return { status: 200, json: async () => ({ ok: true }) }; } });
  await api.getSigned("/me?round=r1");
  await api.post("/attempt", { round: "r1" });
  const ev = (h) => JSON.parse(Buffer.from(h.slice(6), "base64").toString("utf8"));
  const a = ev(seen[0].o.headers.authorization), b = ev(seen[1].o.headers.authorization);
  assert.equal(seen[0].u, "http://127.0.0.1:1/api/opr/me?round=r1");
  assert.deepEqual(a.tags, [["u", "https://testnet-stage.bitcoinarena.io/api/opr/me"], ["method", "GET"]]);
  assert.deepEqual(b.tags.slice(0, 2), [["u", "https://testnet-stage.bitcoinarena.io/api/opr/attempt"], ["method", "POST"]]);
  assert.equal(b.tags[2][1], createHash("sha256").update(seen[1].o.body).digest("hex"));
});

test("#3265 entry states from the service's answers", () => {
  assert.equal(entryOf({ state: "pending-entry" }), "waiting");
  assert.equal(entryOf({ state: "started" }), "paid");
  assert.equal(entryOf({ state: "entry-not-paid" }), "not-paid");
  assert.equal(entryOf({ state: "scored", entry: "pending" }), "waiting");
  assert.equal(entryOf({ state: "invoiced" }), "waiting");
  // the #3265 service's words: /attempt/check and /submit
  assert.equal(entryOf({ ok: true, state: "pending-entry", paid: false, submitted: true }), "waiting");
  assert.equal(entryOf({ ok: true, state: "started", paid: true }), "paid");
  assert.equal(entryOf({ ok: true, state: "scored", paid: true }), "paid");
  assert.equal(entryOf({ ok: true, state: "rejected", paid: false }), "waiting");
  assert.equal(entryOf({ ok: true, state: "entry-not-paid", paid: false }), "not-paid");
  assert.equal(attemptOf({ ok: true, attempt: "x", token: "t", level: { candles: [] }, invoice: "lntb1" }).state, "pending-entry");
});

// a fake service and wallet on a fake clock: the entry waits for the welcome, then pays once
function fakes({ balance = 0 } = {}) {
  let t = T0, paid = false, pays = 0, bal = balance, welcome = true;
  const api = { post: async (path) => (path === "/attempt/check" ? { ok: true, state: paid ? "started" : "pending-entry" } : { ok: false }) };
  const bridge = { balance: () => ({ sats: bal }), welcomeComing: () => welcome, pay: async () => { pays++; bal -= 100; paid = true; return { ok: true, by: "your player wallet" }; } };
  const clock = { now: () => t, sleep: async (ms) => { t += ms; } };
  return { api, bridge, clock, land: () => { bal += 3000; welcome = false; }, pays: () => pays };
}
test("#3265 the entry is paid in the background once the welcome lands, exactly once", async () => {
  const f = fakes();
  const statuses = [];
  const e = createEntry({ api: f.api, bridge: f.bridge, now: f.clock.now, sleep: async (ms) => { await f.clock.sleep(ms); if (statuses.length === 3) f.land(); } });
  const p = e.payInBackground({ attempt: "a", invoice: "lntb100n1x", sats: 100, deadlineMs: T0 + 10 * 60000 }, { onStatus: (k) => statuses.push(k) });
  assert.equal(await p.done, "paid");
  assert.equal(f.pays(), 1);
  assert.deepEqual(statuses.slice(0, 3), ["waiting-welcome", "waiting-welcome", "waiting-welcome"]);
  assert.ok(statuses.includes("paying"));
  assert.equal(statuses.at(-1), "paid");
});
test("#3265 no money by the deadline: the entry gives up and pays nothing", async () => {
  const f = fakes();
  const e = createEntry({ api: f.api, bridge: f.bridge, now: f.clock.now, sleep: f.clock.sleep });
  const p = e.payInBackground({ attempt: "a", invoice: "lntb100n1y", sats: 100, deadlineMs: T0 + 60000 }, {});
  assert.equal(await p.done, "gave-up");
  assert.equal(f.pays(), 0);
});
test("#3265 a failed payment is tried again, not given up on", async () => {
  const f = fakes({ balance: 500 });
  let n = 0; const pay = f.bridge.pay; f.bridge.pay = async (i) => (++n === 1 ? { ok: false, why: "no route" } : pay(i));
  const e = createEntry({ api: f.api, bridge: f.bridge, now: f.clock.now, sleep: f.clock.sleep });
  const seen = [];
  assert.equal(await e.payInBackground({ attempt: "a", invoice: "lntb100n1z", sats: 100, deadlineMs: T0 + 600000 }, { onStatus: (k) => seen.push(k) }).done, "paid");
  assert.ok(seen.includes("pay-failed"));
  assert.equal(f.pays(), 1);
});

test("#3270 the intro names the X account: not linked with the link, @handle ✓ once linked, nothing before /me or without the Arena", () => {
  assert.deepEqual(introModel({ round: round(), me: me(), board, wallet: W(), nowMs: T0 }).x, { text: "X account: not linked", link: true });
  assert.deepEqual(introModel({ round: null, me: me(), board, wallet: W(), nowMs: T0 }).x, { text: "X account: not linked", link: true });
  assert.deepEqual(introModel({ round: round(), me: me({ x: { username: "satoshi" } }), board, wallet: W(), nowMs: T0 }).x, { text: "X account: @satoshi ✓", link: false });
  assert.equal(introModel({ round: round(), me: null, board, wallet: W(), nowMs: T0 }).x, null);
  assert.equal(introModel({ round: null, me: null, board: [], wallet: null, nowMs: T0 }).x, undefined);
});
