// Orange Pill Run - what the intro and result screens say (kanban #3251, #3265). Pure: the models are made from the service's answers and the
// wallet's state, so node tests check every line and every reason the Play button is off; main.js only puts them on the page.

export const fmtSats = (n) => Math.max(0, Math.floor(Number(n) || 0)).toLocaleString("en-US");
export function fmtLeft(ms) {
  const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? h + " h " + m + " min" : m ? m + " min " + x + " s" : x + " s";
}
export const fmtTime = (t) => (Number.isFinite(Number(t)) ? Number(t).toFixed(1) + " s" : "-");

/** The player's own best run of the round and its rank on the board (rows of GET /board, the player's name from GET /me). */
export function myBest(me, board) {
  const runs = ((me && me.attempts) || []).filter((a) => a && a.state === "scored" && a.score && Number.isFinite(a.score.total));
  if (!runs.length) return null;
  runs.sort((a, b) => (b.score.total - a.score.total) || (a.score.timeS - b.score.timeS));
  const best = runs[0];
  const row = (board || []).find((r) => r.name === me.name && r.score === best.score.total);
  return { total: best.score.total, timeS: best.score.timeS, attempt: best.attempt, rank: row ? row.rank : null };
}

/**
 * The intro: { line, bounty, best, pot, attempts, mine, left, button: { label, disabled, why }, practice }.
 * wallet: { pubkey, balance: { sats } | null, welcomeComing } or null (no Arena page around the game: practice only).
 */
/**
 * WHO CAN WIN THE PLAY BOUNTY (#3251, owner 2026-11-22: "unmistakable" - without a linked, verified X account AND a valid Lightning address
 * there is no share): { ok, text, link, ln } while the player's /me is known - link: the Link X button belongs beside it; ln: the address field.
 */
export function xLine(me, sats = PRIZE_SATS) {
  if (!me) return null;
  const hasX = !!(me.x && me.placed), hasLn = !!me.lnAddress;
  // BOTH PARTS, ALWAYS, EACH WITH ITS STATE (owner 2026-11-22: "Mein X wird gar nicht angezeigt"): red only for what is missing
  const handle = me.x ? (me.x.username ? "@" + me.x.username : "linked") : "";
  const parts = [
    hasX ? { text: "✓ X " + handle, ok: true } : me.x ? { text: "X " + handle + " not verified yet", ok: false } : { text: "X not linked", ok: false },
    hasLn ? { text: "⚡ " + me.lnAddress + " ✓", ok: true } : { text: "⚡ no Lightning address", ok: false },
  ];
  const ok = hasX && hasLn;
  if (ok) parts.push({ text: "- you can win", ok: true, sep: " " });
  const text = parts.map((x, i) => (i ? (x.sep || " · ") : "") + x.text).join("");
  return { ok, text, parts, link: !me.x, ln: !hasLn };
}

/**
 * THE RUNS THIS PLAYER OPENED IN THE ROUND (#3251): GET /me's count, and never fewer than the runs it lists plus the ones this tab opened since
 * (opened: attempt ids from POST /attempt) - a /me read before the run, or one that did not answer, must not show the run as not made.
 */
export function usedOf(me, opened = []) {
  const ids = new Set(((me && me.attempts) || []).map((a) => a && a.attempt).filter(Boolean));
  for (const a of opened || []) if (a) ids.add(a);
  return Math.max(me ? Number(me.used || 0) : 0, ids.size);
}

/**
 * THE INTRO'S LEADERBOARD (#3251, owner 2026-11-22): the top 10 as { rank, name, score, time, me }, the player's own row marked; a player
 * placed below the 10 gets their row after them (own), behind a divider. me: GET /me (its name); board: GET /board's rows.
 */
export const INTRO_TOP = 10;
export function introBoard(board, me, n = INTRO_TOP) {
  const name = me && me.name, rows = (board || []).map((r) => ({ rank: String(r.rank), name: String(r.name || ""), score: fmtSats(r.score), time: fmtTime(r.timeS), placed: !!r.placed, me: !!name && r.name === name }));
  const top = rows.slice(0, n), own = rows.slice(n).find((r) => r.me) || null;
  return { rows: top, own, empty: top.length ? null : "No run yet - be the first" };
}

/** A FREE ROUND (kanban #3273, owner 2026-11-22): entry 0 - no wallet, no balance, no faucet; the 2,000 real sats still go to the winner. */
export const isFree = (round) => !!round && !(Number(round.entrySats) > 0);
export const FREE_LABEL = "Play · free";
export function introModel({ round, me, board, wallet, nowMs = Date.now(), loading = false, opened = [], top = INTRO_TOP }) {
  const m = { line: "Run yesterday's Bitcoin chart. Tap to jump. Don't fall.", practice: false };
  if (!wallet) {
    m.practice = true;
    m.button = { label: "Practice run (free)", disabled: false, why: "Open the game in the Arena to play for the daily prize." };
    return m;
  }
  m.x = xLine(me, round && round.bountySats > 0 ? round.bountySats : PRIZE_SATS);
  // #3251: until the first GET /round has answered, the intro does not say "no round" (it showed for a second before the round loaded)
  // the game is free (#3273): until a round says otherwise the button says so
  if (!round && loading) {
    m.button = { label: FREE_LABEL, disabled: true, why: "Loading the round …" };
    return m;
  }
  if (!round) {
    m.button = { label: FREE_LABEL, disabled: true, why: "No round is open right now." };
    return m;
  }
  const free = isFree(round), entry = free ? 0 : Number(round.entrySats), max = Number(round.maxAttempts || 5);
  m.free = free;
  // THE PRIZE, PROMINENT (owner 2026-11-22: "Es fehlt jede Nachricht, dass der beste Score am Ende des Tages 2000 echte Sats bekommt"): a daily
  // round says it with what it needs (#3250: a Lightning address, a verified X account); a test round shows the daily prize to come, and its own
  // "no play bounty" small. The prize line takes the old "Play bounty: ..." line's place on a daily round
  m.prize = prizeLine(round, nowMs);
  m.bounty = round.test ? "Test round · no play bounty" : null;   // the round badge's tooltip (owner 2026-11-22: off the intro)
  m.tag = (round.test ? "TEST " : "DAY ") + (round.number || "");
  m.best = round.best ? fmtSats(round.best.score) + " in " + fmtTime(round.best.timeS) + " by " + round.best.name : "No run yet - be the first";
  const split = Array.isArray(round.split) ? round.split.join(" / ") : "50 / 30 / 20";
  m.pot = free ? null : fmtSats(round.potSats) + " testnet sats · split " + split;
  const used = usedOf(me, opened);
  m.attempts = "Your attempts: " + used + " of " + max;
  const mine = me ? myBest(me, board) : null;
  m.mine = mine ? "Your best: " + fmtSats(mine.total) + (mine.rank ? " · rank " + mine.rank : "") : "Your best: no run yet";
  m.left = round.phase === "soon" ? "Opens in " + fmtLeft(round.startMs - nowMs) : "Time left: " + fmtLeft(round.endMs - nowMs);
  // the same lines as label and value, for the intro's grid; the owner 2026-11-22: no pot line on the intro, the top 10 instead of "Current best"
  m.facts = [[round.phase === "soon" ? "Opens in" : "Time left", m.left.replace(/^(Opens in|Time left:) /, ""), "f3"],
    ["Your attempts", used + " of " + max, "f3"], ["Your best", mine ? fmtSats(mine.total) + (mine.rank ? " · #" + mine.rank : "") : "no run yet", "f3"]];
  m.board = introBoard(board, me, top);
  const label = free ? FREE_LABEL : "Play · " + fmtSats(entry) + " testnet sats";
  const off = (why) => (m.button = { label, disabled: true, why });
  const pay = free ? { state: "ok", need: 0 } : payableOf(wallet, entry);
  if (round.phase === "ended") off("This round has ended.");
  else if (round.phase === "last-call") off("No new attempts in the last 5 minutes of a round.");
  else if (round.phase === "soon") off("The round opens in " + fmtLeft(round.startMs - nowMs) + ".");
  else if (round.phase !== "open") off("The round is being prepared - it opens once its level is posted on chain.");
  else if (used >= max) off("All " + max + " attempts of this round are used.");
  else if (!wallet.pubkey) off(free ? "Signing you in …" : "Your Arena wallet is opening …");
  // A NEW, EMPTY WALLET PLAYS AT ONCE (kanban #3265): its welcome sats are on their way and pay the entry in the background; so do sats
  // merging in from another wallet and a faucet top-up (#3251)
  else if (pay.state === "short") {
    off(wallet.canTopUp ? "You need about " + fmtSats(pay.need) + " sats - get 300 free sats" : "Your balance is too low: you need about " + fmtSats(pay.need) + " testnet sats (the entry and the payment's fee).");
    if (wallet.canTopUp) m.topUp = { label: "Get 300 free sats" };
  }
  else m.button = { label, disabled: false, why: pay.state === "coming" ? (wallet.welcomeComing ? "Your welcome sats are on their way" : "Your sats are on their way") + " - they pay the entry while you play." : "" };
  return m;
}

/**
 * CAN THE WALLET PAY AN ENTRY (kanban #3251): { state: 'ok' | 'coming' | 'short' | 'unknown', need }. A Lightning payment leaves from one
 * federation and costs the gateway's fee on top: balance.payable (what the best federation can send after the fees) when the page has read
 * it, else balance.best (or sats) less a guessed fee. Sats on their way (the welcome, a top-up, sats merging in) let the run start - the entry
 * is paid in the background once they land (#3265).
 */
export const FEE_GUESS_SATS = 3;
export function payableOf(wallet, entry = 100) {
  const b = wallet && wallet.balance;
  if (!b) return { state: wallet && (wallet.welcomeComing || wallet.topUpComing) ? "coming" : "unknown", need: entry + FEE_GUESS_SATS };
  const best = Number.isFinite(Number(b.best)) && b.best != null ? Number(b.best) : Number(b.sats) || 0;
  const payable = b.payable == null || !Number.isFinite(Number(b.payable)) ? null : Number(b.payable);
  // the wallet's withdrawableMsat leaves the gateway's fee out when no gateway is named (measured on stage: 3,000 held, 3,000 "payable"),
  // so the guessed fee is the least taken
  const fee = Math.max(FEE_GUESS_SATS, payable !== null && best > 0 ? best - payable : 0);
  const need = entry + fee;
  if (best >= need) return { state: "ok", need };
  const coming = Number(b.coming) || 0;
  if (wallet.welcomeComing || wallet.topUpComing || (coming > 0 && best + coming >= need)) return { state: "coming", need };
  return { state: "short", need };
}

/** The daily prize line (#3251): { text, small } - a test round's says from when (the first daily round) or "Daily:". */
export const PRIZE_SATS = 2000, FIRST_DAILY_MS = Date.UTC(2026, 10, 23), FIRST_DAILY_WORDS = "23 Nov";
export function prizeLine(round, nowMs = Date.now()) {
  if (!round) return null;
  const sats = fmtSats(round.bountySats > 0 ? round.bountySats : PRIZE_SATS);
  // short (owner 2026-11-22, iPhone): two lines at most on a 375 px phone
  const text = "🏆 " + (isFree(round) ? "Free to play · daily" : "Daily") + " best score wins " + sats + " real sats", small = "needs X + Lightning address";
  if (!round.test || nowMs >= FIRST_DAILY_MS) return { text, small };
  return { text: "From " + FIRST_DAILY_WORDS + ": " + text, small };
}

/** What the result screen says about the entry (kanban #3265). */
export function entryLine(entry, why) {
  if (entry === "paid") return { kind: "ok", text: "Entry paid - this run counts." };
  if (entry === "not-paid") return { kind: "bad", text: "Entry not paid - this run does not count." + (why ? " (" + why + ")" : "") };
  if (entry === "practice") return { kind: "", text: "Practice run - not sent." };
  if (entry === "free") return { kind: "", text: "" };   // a free round has no entry to speak of (#3273)
  return { kind: "wait", text: "Waiting for your entry - the run counts once the 100 sats are paid." };
}

/**
 * The result: { title, entry, rows: [[label, value]], total, rank, beat, left, xPrompt }.
 * res: the run (resultOf); before/after: myBest() before and after the run; me: GET /me after it.
 */
export function resultModel({ res, parTime, timePerS = 20, entry, entryWhy, before, after, me, max = 5, mode = "play", submitWhy = null, opened = [], round = null, nowMs = Date.now() }) {
  const out = {};
  out.title = mode === "replay" ? "Replay: " + (res.finished ? "flag in " + fmtTime(res.timeS) : "time is up") : res.finished ? "Flag reached in " + fmtTime(res.timeS) : "Time is up";
  out.entry = entryLine(entry, entryWhy);
  const p = res.parts || {};
  out.rows = [["Sats (coins and ₿ blocks)", p.sats], ["Shitcoins stomped × 10", p.stomps], ["Flag reached", p.goal], ["Time bonus (" + timePerS + " per second under " + parTime + " s)", p.time], ["Day high", p.high]];
  if (res.clean) out.rows.push(["No hits", "×1.5"]);
  out.total = res.total;
  if (mode !== "play") return out;
  if (submitWhy) out.refused = "The service did not take this run: " + submitWhy;
  out.rank = after && after.rank ? "Rank " + after.rank + " after this run" : entry === "paid" || entry === "free" ? "Not on the board yet" : null;
  out.beat = !before ? (after ? "Your first score of the round" : null) : res.total > before.total ? "New best - you beat your " + fmtSats(before.total) : "Your best stays " + fmtSats(before.total);
  // the prize, once more on the result (#3251, owner 2026-11-22)
  if (round) { const sats = fmtSats(round.bountySats > 0 ? round.bountySats : PRIZE_SATS);
    // one line (owner 2026-11-22, iPhone): "Rank 2 · daily best wins 2,000 real sats"
    out.prize = (after && after.rank ? "Rank " + after.rank + " · d" : round.test && nowMs < FIRST_DAILY_MS ? "From " + FIRST_DAILY_WORDS + ": d" : "D") + "aily best wins " + sats + " real sats"; }
  if (me) out.left = "Attempts left: " + Math.max(0, max - usedOf(me, opened)) + " of " + max;   // #3251: this run counts, whatever /me said before it
  // #3251: not eligible - said plainly, once (owner 2026-11-22)
  // one line, the intro's words (owner 2026-11-22, iPhone); its Link X button beside it
  if (me) { const x = xLine(me); out.status = x; out.linkX = x.link; if (!x.ok) out.notCounted = x.text; }
  // the three facts in one row: "Rank 2 · best 218 · 95 of 99 left"
  if (me) { const best = Math.max(after ? after.total : 0, before ? before.total : 0);
    out.facts = [after && after.rank ? "Rank " + after.rank : "Not ranked yet", best > 0 ? "best " + fmtSats(best) : null, Math.max(0, max - usedOf(me, opened)) + " of " + max + " left"].filter(Boolean).join(" · "); }
  if (me && !me.x) out.xPrompt = "Link your X account to be placed and win.";
  else if (me && me.x && !me.placed) out.xPrompt = "Your X account " + (me.x.username ? "@" + me.x.username + " " : "") + "is linked - " + (me.placedWhy || "not verified yet") + ".";
  return out;
}

/**
 * THE LIGHTNING ADDRESS FIELD (kanban #3250), checked as the player types: null when it looks like one (the service then asks the wallet), or the
 * short reason. The same rule as the service's lnAddressSyntax (user [a-z0-9-_.+] @ a public domain); the service has the last word.
 */
export function lnSyntaxWhy(text) {
  const a = String(text == null ? "" : text).trim().toLowerCase();
  const m = /^([a-z0-9\-_.+]{1,64})@([a-z0-9.-]{1,253})$/.exec(a);
  if (!m) return "Not a Lightning address";
  const labels = m[2].split(".");
  if (labels.length < 2 || labels.some((l) => !l || l.length > 63 || l.startsWith("-") || l.endsWith("-")) || !/^[a-z][a-z0-9-]*[a-z0-9]$|^[a-z]{2,}$/.test(labels[labels.length - 1])) return "Not a Lightning address";
  if (/(^|\.)(localhost|local|internal|lan|home|arpa|onion|localdomain|intranet|ts\.net|nip\.io|sslip\.io|localtest\.me)$/.test(m[2])) return "That is not a public wallet";
  return null;
}
/** What the field says under it: { text, kind: "ok" | "bad" | "" , canSave }. stored: GET /me's lnAddress. */
export function lnFieldModel(text, stored) {
  const a = String(text == null ? "" : text).trim().toLowerCase();
  if (!a) return { text: "", kind: "", canSave: false };
  if (stored && a === stored) return { text: "✓ saved", kind: "ok", canSave: false };
  const why = lnSyntaxWhy(a);
  return why ? { text: why, kind: "bad", canSave: false } : { text: "", kind: "", canSave: true };
}

/** The leaderboard rows: [[rank, name, score, time, placed]] */
export const boardRows = (board) => (board || []).map((r) => ({ rank: String(r.rank), name: String(r.name || ""), score: fmtSats(r.score), time: fmtTime(r.timeS), placed: !!r.placed, replay: r.replay || null }));
