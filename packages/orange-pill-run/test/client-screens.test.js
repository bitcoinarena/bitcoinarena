// kanban #3251, #3265: the intro's and result's lines, the Play button's reasons, the signed calls and the entry paid in the background.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { introModel, resultModel, entryLine, myBest, fmtLeft, lnSyntaxWhy, lnFieldModel } from "../client/src/screens.js";
import { makeApi } from "../client/src/api.js";
import { createEntry, entryOf, attemptOf } from "../client/src/entry.js";
import { RULES } from "../client/src/rules.js";

const T0 = Date.parse("2026-11-23T10:00:00Z");
const round = (o = {}) => ({ id: "2026-11-23", number: 1, test: false, phase: "open", startMs: Date.parse("2026-11-23T00:00:00Z"), endMs: Date.parse("2026-11-24T00:00:00Z"),
  entrySats: 100, maxAttempts: 5, split: [50, 30, 20], potSats: 1200, bountySats: 2500, best: { score: 1234, timeS: 41.25, name: "alice" }, ...o });
const me = (o = {}) => ({ ok: true, name: "bob", rowKey: "kb", used: 2, maxAttempts: 5, x: null, placed: false, attempts: [
  { attempt: "a1", state: "scored", score: { total: 700, timeS: 50 } }, { attempt: "a2", state: "scored", score: { total: 980, timeS: 44 } }], ...o });
const board = [{ rank: 1, name: "alice", key: "ka", score: 1234, timeS: 41.25 }, { rank: 4, name: "bob", key: "kb", score: 980, timeS: 44 }];
const W = (o = {}) => ({ pubkey: "ab".repeat(32), balance: { sats: 3000 }, welcomeComing: false, ...o });

test("#3251 the intro: one line, bounty, best, pot and split, attempts, own best and rank, time left, the Play label", () => {
  const m = introModel({ round: round(), me: me(), board, wallet: W(), nowMs: T0 });
  assert.equal(m.line, "Run yesterday's Bitcoin chart. Tap to jump. Don't fall.");
  assert.equal(m.bounty, null);   // the prize line says it (owner 2026-11-22)
  assert.deepEqual(m.prize, { text: "🏆 Daily best score wins 2,500 real sats", small: "optional: X (follow @bitcoinarena_io) + Lightning address, after a run" });
  assert.equal(m.best, "1,234 in 41.3 s by alice");
  assert.equal(m.pot, "1,200 testnet sats · split 50 / 30 / 20");
  assert.equal(m.attempts, "Your attempts: 2 of 5");
  assert.equal(m.mine, "Your best: 980 · rank 4");
  assert.equal(m.left, "Time left: 14 h 0 min");
  assert.deepEqual(m.button, { label: "Play · 100 testnet sats", disabled: false, why: "" });
  assert.equal(m.facts.length, 3);   // owner 2026-11-22: no "Pot so far" and no "Current best" on the intro - the top 10 instead
  assert.equal(m.facts.some((f) => /Pot|Current best/.test(f[0])), false);
  assert.deepEqual(m.board.rows.map((r) => [r.rank, r.name, r.score, r.time, r.me]), [["1", "alice", "1,234", "41.3 s", false], ["4", "bob", "980", "44.0 s", true]]);
  assert.equal(m.board.own, null);
});

test("#3251 the Play button is off with a reason: 5 attempts used, last 5 minutes, balance too low, not open", () => {
  const off = (o) => introModel({ nowMs: T0, round: round(), me: me(), board, wallet: W(), ...o }).button;
  assert.deepEqual(off({ me: me({ used: 5 }) }), { label: "Play · 100 testnet sats", disabled: true, why: "All 5 attempts of this round are used." });
  assert.equal(off({ round: round({ phase: "last-call" }) }).why, "No new attempts in the last 5 minutes of a round.");
  assert.equal(off({ wallet: W({ balance: { sats: 40 } }) }).why, "Your balance is too low: you need about 103 testnet sats (the entry and the payment's fee).");
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
  assert.equal(r.xPrompt, "Add your X handle to be placed and win.");
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
    "The play bounty is paid in real sats and can end or change at any time."]) assert.ok(all.includes(s), s);
  assert.match(RULES.find((r) => r[0] === "Speed")[1], /Faster finishes score much more: 20 points for every second under/);   // #3271
  const speed = RULES.find((r) => r[0] === "Speed")[1];   // #3550 (owner 2026-11-23): x1.5 only for a run that reaches the flag; +3 s per death
  assert.ok(speed.includes("a run that reaches the flag without a hit scores ×1.5"), speed);
  assert.ok(!speed.includes("a run without a hit scores"), speed);
  assert.ok(speed.includes("Each death adds 3 s to your run time"), speed);
  assert.match(RULES.find((r) => r[0] === "Jump")[1], /short tap or click is a small hop; hold longer to jump higher.*click, Space or the Up arrow/);
  for (const k of ["Round", "Level", "Free to play", "Attempts", "Score", "Speed", "Tie-break", "Jump", "Play bounty", "X account"]) assert.ok(RULES.some((r) => r[0] === k), k);
});

test("#3550 the start hint says a short press hops and a long one jumps high; a mouse player reads click, Space or Up", async () => {
  const { hintText } = await import("../client/src/rules.js");
  assert.equal(hintText(false), "Tap: small hop · hold: high jump");
  assert.equal(hintText(true), "Click, Space or ↑: short = small hop, hold = high jump");
  const html = (await import("node:fs")).readFileSync(new URL("../client/index.template.html", import.meta.url), "utf8");
  assert.ok(html.includes('<div id="hint" hidden>Tap: small hop · hold: high jump</div>'));
  assert.ok(!html.includes("Tap anywhere to jump"));
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
  assert.deepEqual(a.tags.slice(0, 2), [["u", "https://testnet-stage.bitcoinarena.io/api/opr/me"], ["method", "GET"]]);
  assert.equal(a.tags[2][0], "nonce"); assert.match(a.tags[2][1], /^[0-9a-f]{24}$/);   // #3251: every sign-in its own event
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
  // #3251: both parts always, each with its state (owner 2026-11-22: "Mein X wird gar nicht angezeigt")
  const st = (o) => { const x = introModel({ round: round(), me: me(o), board, wallet: W(), nowMs: T0 }).x; return [x.ok, x.text, x.link, x.ln, x.parts.map((p) => p.ok)]; };
  // #3328: nothing saved is no error - no red "X not linked" / "no Lightning address"; the empty fields stand there instead
  assert.deepEqual(st({}), [false, "", true, true, []]);
  assert.deepEqual(st({ x: { username: "georgeprime" }, placed: true }), [false, "✓ X @georgeprime", false, true, [true]]);
  assert.deepEqual(st({ x: { username: "satoshi" }, placed: false, lnAddress: "a@wos.com" }), [false, "X @satoshi not verified yet · ⚡ a@wos.com ✓", false, false, [false, true]]);
  assert.deepEqual(st({ x: { username: "georgeprime" }, placed: true, lnAddress: "name@wallet.com" }), [true, "✓ X @georgeprime · ⚡ name@wallet.com ✓ - you can win", false, false, [true, true, true]]);
  assert.equal(introModel({ round: round(), me: null, board, wallet: W(), nowMs: T0 }).x, null);
  assert.equal(introModel({ round: null, me: null, board: [], wallet: null, nowMs: T0 }).x, undefined);
});

test("#3251 the intro says nothing about 'no round' until the first GET /round answered; the three short facts in one row", () => {
  const l = introModel({ round: null, me: null, board: [], wallet: W(), nowMs: T0, loading: true });
  assert.deepEqual(l.button, { label: "Play · free", disabled: true, why: "Loading the round …" });   // the game is free (#3273)
  assert.equal(introModel({ round: null, me: null, board: [], wallet: W(), nowMs: T0 }).button.why, "No round is open right now.");
  const m = introModel({ round: round(), me: me(), board, wallet: W(), nowMs: T0, loading: true });   // a round already known: as always
  assert.equal(m.button.disabled, false);
  assert.deepEqual(m.facts.map((f) => [f[1], f[2]]), [["14 h 0 min", "f3"], ["2 of 5", "f3"], ["980 · #4", "f3"]]);
});

test("#3250 the Lightning address field: live syntax, the stored one shows ✓ saved, Save only for a new well-formed one; the rules line", () => {
  for (const ok of ["alice@walletofsatoshi.com", "Alice@WalletOfSatoshi.com", "a.b-c_d+e@getalby.com"]) assert.equal(lnSyntaxWhy(ok), null, ok);
  for (const bad of ["", "alice", "a@b", "a b@wos.com", "a@wos.com:443", "a@1.2.3.4"]) assert.equal(lnSyntaxWhy(bad), "Not a Lightning address", bad);
  assert.equal(lnSyntaxWhy("a@box.local"), "That is not a public wallet");
  assert.deepEqual(lnFieldModel("", null), { text: "", kind: "", canSave: false });
  assert.deepEqual(lnFieldModel("me@wos.com", "me@wos.com"), { text: "✓ saved", kind: "ok", canSave: false });
  assert.deepEqual(lnFieldModel(" Me@WOS.com ", "me@wos.com"), { text: "✓ saved", kind: "ok", canSave: false });
  assert.deepEqual(lnFieldModel("me@", null), { text: "Not a Lightning address", kind: "bad", canSave: false });
  assert.deepEqual(lnFieldModel("new@wos.com", "me@wos.com"), { text: "", kind: "", canSave: true });
  assert.ok(RULES.find((r) => r[0] === "Play bounty")[1].includes("The play bounty goes to the best player with a valid Lightning address saved by one hour after the round."));
});

test("#3251 the counters count the run just made: GET /me's count, its listed runs, and the runs this tab opened", async () => {
  const { usedOf } = await import("../client/src/screens.js");
  assert.equal(usedOf(null), 0);
  assert.equal(usedOf(me({ used: 0, attempts: [] }), ["a9"]), 1);           // /me read before the run: the run still counts
  assert.equal(usedOf(me({ used: 1, attempts: [{ attempt: "a9" }] }), ["a9"]), 1);   // /me caught up: not twice
  const res = { finished: false, timeS: 180, total: 120, clean: false, parts: {} };
  const r = resultModel({ res, parTime: 60, entry: "paid", me: me({ used: 0, attempts: [] }), max: 99, opened: ["a9"] });
  assert.equal(r.left, "Attempts left: 98 of 99");
  const i = introModel({ round: round({ maxAttempts: 99, test: true, bountySats: 0 }), me: me({ used: 0, attempts: [] }), board: [], wallet: W(), nowMs: T0, opened: ["a9"] });
  assert.equal(i.attempts, "Your attempts: 1 of 99");
  assert.equal(i.bounty, "Test round · no play bounty");
  assert.equal(i.board.empty, "No run yet - be the first");
});

test("#3251 the intro's board: the top 10, the player's row marked; outside the 10 the player's row comes after them", async () => {
  const { introBoard } = await import("../client/src/screens.js");
  const b = Array.from({ length: 14 }, (_, k) => ({ rank: k + 1, name: "p" + (k + 1), key: "k" + (k + 1), score: 2000 - k * 10, timeS: 40 + k, placed: k % 2 === 0 }));
  const x = introBoard(b, { name: "p13", rowKey: "k13" });
  assert.equal(x.rows.length, 10); assert.equal(x.rows.some((r) => r.me), false);
  assert.deepEqual([x.own.rank, x.own.name, x.own.me], ["13", "p13", true]);
  const y = introBoard(b, { name: "p3", rowKey: "k3" });
  assert.equal(introBoard(b, { name: "p3" }).rows.some((r) => r.me), false);   // #3277: a name alone marks no row
  assert.equal(y.rows[2].me, true); assert.equal(y.own, null);
  assert.equal(introBoard(b, null).own, null);
});

test("#3251 sound: the world's counters name the events; the loop is 16 bars of eighths at 140 bpm", async () => {
  const { worldEvents, LOOP, BPM } = await import("../client/src/audio.js");
  const s = { coins: 0, blocks: 0, stomps: 0, hits: 0, powers: 0, high: false, cp: 0, hurtT: 0, shield: false, boost: 0, vy: 0, dying: 0, done: false, finished: false };
  assert.deepEqual(worldEvents(s, { ...s, vy: -9 }), ["jump"]);
  assert.deepEqual(worldEvents(s, { ...s, coins: 1 }), ["coin"]);
  assert.deepEqual(worldEvents(s, { ...s, stomps: 1, vy: -7 }), ["stomp"]);
  assert.deepEqual(worldEvents(s, { ...s, powers: 1 }), ["power"]);
  assert.deepEqual(worldEvents(s, { ...s, hits: 1, dying: 55, vy: -6 }), ["death"]);
  assert.deepEqual(worldEvents(s, { ...s, hurtT: 70 }), ["hurt"]);
  assert.deepEqual(worldEvents(s, { ...s, cp: 1 }), ["checkpoint"]);
  assert.deepEqual(worldEvents(s, { ...s, done: true, finished: true }), ["flag"]);
  assert.deepEqual(worldEvents(s, { ...s, done: true }), ["timeup"]);
  assert.deepEqual(worldEvents(null, s), []);
  assert.equal(BPM, 140); assert.equal(LOOP.eighths, 128); assert.equal(LOOP.bass.length, 128); assert.equal(LOOP.hats.length, 128);
});

test("#3251 the wallet pays from one federation, the fee on top: 100 sat is not enough, sats on their way are; the top-up offer", async () => {
  const { payableOf } = await import("../client/src/screens.js");
  const w = (balance, o = {}) => W({ balance, ...o });
  // the owner's case: "100 sat ⇄" in the bar, all of it still merging in - even once landed it cannot pay 100 + the fee: said, with the top-up
  let m = introModel({ round: round(), me: me(), board, wallet: w({ sats: 0, total: 100, coming: 100, best: 0, payable: null }, { canTopUp: true }), nowMs: T0 });
  assert.equal(m.button.disabled, true); assert.equal(m.button.why, "You need about 103 sats - get 300 free sats"); assert.deepEqual(m.topUp, { label: "Get 300 free sats" });
  // 300 merging in: Play stays on, the entry is paid in the background once they land
  m = introModel({ round: round(), me: me(), board, wallet: w({ sats: 0, total: 300, coming: 300, best: 0, payable: null }, { canTopUp: true }), nowMs: T0 });
  assert.equal(m.button.disabled, false); assert.equal(m.button.why, "Your sats are on their way - they pay the entry while you play.");
  // exactly 100 spendable in a non-lobby federation, the gateway's fee read: 97 payable - short, with the faucet's top-up
  m = introModel({ round: round(), me: me(), board, wallet: w({ sats: 100, total: 100, coming: 0, best: 100, payable: 97 }, { canTopUp: true }), nowMs: T0 });
  assert.equal(m.button.disabled, true); assert.equal(m.button.why, "You need about 103 sats - get 300 free sats"); assert.deepEqual(m.topUp, { label: "Get 300 free sats" });
  // the top-up asked: Play on
  m = introModel({ round: round(), me: me(), board, wallet: w({ sats: 100, total: 100, coming: 0, best: 100, payable: 97 }, { canTopUp: true, topUpComing: true }), nowMs: T0 });
  assert.equal(m.button.disabled, false); assert.equal(m.topUp, undefined);
  // 300 in another federation, 0 in the lobby's: paid from there
  assert.equal(payableOf(w({ sats: 300, total: 300, coming: 0, best: 300, payable: 296 }), 100).state, "ok");
  // two federations of 60 each: 120 in all, but one payment cannot leave from both
  assert.equal(payableOf(w({ sats: 120, total: 120, coming: 0, best: 60, payable: 57 }), 100).state, "short");
  // payable not read yet: 100 is short of 100 + the guessed fee, 103 is enough
  assert.deepEqual(payableOf(w({ sats: 100, best: 100 }), 100), { state: "short", need: 103 });
  assert.equal(payableOf(w({ sats: 103, best: 103 }), 100).state, "ok");
  // no faucet around: the plain reason, no button
  m = introModel({ round: round(), me: me(), board, wallet: w({ sats: 100, best: 100, payable: 97 }), nowMs: T0 });
  assert.match(m.button.why, /^Your balance is too low: you need about 103 testnet sats/); assert.equal(m.topUp, undefined);
});

test("#3251 the entry is paid only when one federation can send it after the fees (payable), not on the summed balance", async () => {
  const calls = []; let bal = { sats: 120, best: 60, payable: 57 };
  const bridge = { balance: () => bal, welcomeComing: () => false, pay: async (inv) => { calls.push(inv); return { ok: true }; } };
  let paid = false;
  const api = { post: async (path) => (path === "/attempt/check" ? (paid ? { ok: true, state: "started", paid: true } : { ok: true, state: "pending-entry", paid: false }) : { ok: false }) };
  let t = 0; const seen = [];
  const e = createEntry({ api, bridge, now: () => t, sleep: async (ms) => { t += ms; if (t > 6000) { bal = { sats: 300, best: 300, payable: 296 }; } if (calls.length) paid = true; } });
  const r = await e.payInBackground({ attempt: "a1", invoice: "lntb1", sats: 100, deadlineMs: 60000 }, { onStatus: (k, w) => seen.push([k, w]) }).done;
  assert.equal(r, "paid"); assert.equal(calls.length, 1);
  assert.deepEqual(seen[0], ["waiting-balance", "57 of 100 sats"]);
});

test("#3251 the daily prize: prominent on the intro (a test round shows it from Mon 23 Nov), and on the result with the rank", async () => {
  const { prizeLine } = await import("../client/src/screens.js");
  const before = Date.parse("2026-11-22T09:00:00Z");
  const t = introModel({ round: round({ test: true, bountySats: 0, maxAttempts: 99 }), me: me(), board, wallet: W(), nowMs: before });
  assert.equal(t.prize.text, "From 23 Nov: 🏆 Daily best score wins 2,500 real sats");
  assert.equal(t.bounty, "Test round · no play bounty");
  assert.equal(prizeLine(round({ test: true, bountySats: 0 }), T0).text, "🏆 Daily best score wins 2,500 real sats");
  const res = { finished: true, timeS: 40.5, total: 1100, clean: true, parts: {} };
  assert.equal(resultModel({ res, parTime: 60, entry: "paid", after: { total: 1100, rank: 3 }, me: me(), round: round(), nowMs: T0 }).prize, "Rank 3 · daily best wins 2,500 real sats");
  assert.equal(resultModel({ res, parTime: 60, entry: "paid", after: { total: 1100, rank: 1 }, me: me(), round: round({ test: true, bountySats: 0 }), nowMs: before }).prize, "Rank 1 · daily best wins 2,500 real sats");
  assert.equal(resultModel({ res, parTime: 60, entry: "paid", me: me() }).prize, undefined);
});

test("#3251 the result says plainly when a run cannot win the play bounty; the rules say it in one sentence", () => {
  const res = { finished: true, timeS: 40.5, total: 1100, clean: true, parts: {} };
  assert.equal(resultModel({ res, parTime: 60, entry: "paid", me: me({ lnAddress: "a@wos.com" }), round: round() }).notCounted, "⚡ a@wos.com ✓");
  assert.equal(resultModel({ res, parTime: 60, entry: "paid", me: me({ x: { username: "s" }, placed: true, lnAddress: "a@wos.com" }), round: round() }).notCounted, undefined);
  assert.ok(RULES.find((r) => r[0] === "Play bounty")[1].endsWith("No X account and no valid Lightning address: no play bounty."));
});

test("#3251 a small phone: the board can show the top 3 and the player's own row; the round badge is short", () => {
  const b = Array.from({ length: 8 }, (_, k) => ({ rank: k + 1, name: "p" + (k + 1), key: "k" + (k + 1), score: 900 - k, timeS: 40 }));
  const m = introModel({ round: round({ test: true, number: 3 }), me: me({ name: "p6", rowKey: "k6" }), board: b, wallet: W(), nowMs: T0, top: 3 });
  assert.deepEqual(m.board.rows.map((r) => r.name), ["p1", "p2", "p3"]); assert.equal(m.board.own.name, "p6");
  assert.equal(m.tag, "TEST 3"); assert.equal(m.bounty, "Test round · no play bounty");
  assert.equal(introModel({ round: round({ number: 1 }), me: me(), board: b, wallet: W(), nowMs: T0 }).tag, "DAY 1");
});

test("#3251 the result on a phone: one facts row, the prize and the eligibility one line each", () => {
  const res = { finished: false, timeS: 180, total: 182, clean: false, parts: {} };
  const r = resultModel({ res, parTime: 60, entry: "paid", before: { total: 218 }, after: { total: 218, rank: 2 }, me: me({ used: 4 }), max: 99, round: round({ test: true, bountySats: 0 }), nowMs: Date.parse("2026-11-22T09:00:00Z") });
  assert.equal(r.facts, "Rank 2 · best 218 · 95 of 99 left");
  assert.equal(r.prize, "Rank 2 · daily best wins 2,500 real sats");
  assert.equal(r.notCounted, ""); assert.equal(r.linkX, true);   // #3328: no error-looking text, the fields ask
  assert.equal(resultModel({ res, parTime: 60, entry: "paid", me: me({ used: 1 }), max: 5, round: round({ test: true, bountySats: 0 }), nowMs: Date.parse("2026-11-22T09:00:00Z") }).prize, "From 23 Nov: daily best wins 2,500 real sats");
});

test("#3273 a free round: Play · free, no wallet, balance, faucet or pot; the prize line says free; the result has no entry line", () => {
  const free = round({ entrySats: 0, potSats: 0 });
  // an empty, new tab: no balance, no welcome - Play is on at once
  const m = introModel({ round: free, me: me(), board, wallet: { pubkey: "ab".repeat(32), balance: null, welcomeComing: false, canTopUp: true }, nowMs: T0 });
  assert.deepEqual(m.button, { label: "Play · free", disabled: false, why: "" });
  assert.equal(m.free, true); assert.equal(m.pot, null); assert.equal(m.topUp, undefined);
  assert.deepEqual(m.prize, { text: "🏆 Free to play · daily best score wins 2,500 real sats", small: "optional: X (follow @bitcoinarena_io) + Lightning address, after a run" });
  assert.equal(m.x.text, ""); assert.equal(m.x.link, true); assert.equal(m.x.ln, true);   // #3328: the two empty fields, no red line
  const low = introModel({ round: free, me: me(), board, wallet: W({ balance: { sats: 0, best: 0 } }), nowMs: T0 });
  assert.equal(low.button.disabled, false); assert.equal(low.topUp, undefined);
  assert.equal(introModel({ round: free, me: me({ used: 5 }), board, wallet: W(), nowMs: T0 }).button.why, "All 5 attempts of this round are used.");
  assert.equal(introModel({ round: free, me: null, board, wallet: W({ pubkey: null }), nowMs: T0 }).button.why, "Signing you in …");
  const res = { finished: true, timeS: 40.5, total: 1100, clean: true, parts: {} };
  const r = resultModel({ res, parTime: 60, entry: "free", me: me({ used: 3 }), max: 5, round: free, nowMs: T0 });
  assert.deepEqual(r.entry, { kind: "", text: "" });
  assert.equal(r.rank, "Not on the board yet");
  const a = attemptOf({ ok: true, attempt: "x", token: "t", level: {}, state: "started", free: true, paid: true, sats: 0 });
  assert.equal(a.free, true); assert.equal(a.sats, 0); assert.equal(a.invoice, null); assert.equal(entryOf({ ok: true, state: "started", paid: true }), "paid");
  assert.equal(RULES.find((x) => x[0] === "Free to play")[1], "Free to play. 5 attempts a day, your best counts. The best player with a linked X account that follows @bitcoinarena_io and a valid Lightning address wins 2,500 real sats.");
  assert.ok(!RULES.some((x) => /testnet sats|pot/i.test(x[1])), "no entry or pot in the rules");
});
