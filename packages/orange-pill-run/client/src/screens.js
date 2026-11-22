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
export function introModel({ round, me, board, wallet, nowMs = Date.now() }) {
  const m = { line: "Run yesterday's Bitcoin chart. Tap to jump. Don't fall.", practice: false };
  if (!wallet) {
    m.practice = true;
    m.button = { label: "Practice run (free)", disabled: false, why: "Open the game in the Arena to play for the pot." };
    return m;
  }
  if (!round) {
    m.button = { label: "Play · 100 testnet sats", disabled: true, why: "No round is open right now." };
    return m;
  }
  const entry = Number(round.entrySats || 100), max = Number(round.maxAttempts || 5);
  m.bounty = round.bountySats > 0 ? "Play bounty: " + fmtSats(round.bountySats) + " sats today for rank 1" : round.test ? "Test round · no play bounty" : null;
  m.best = round.best ? fmtSats(round.best.score) + " in " + fmtTime(round.best.timeS) + " by " + round.best.name : "No run yet - be the first";
  const split = Array.isArray(round.split) ? round.split.join(" / ") : "50 / 30 / 20";
  m.pot = fmtSats(round.potSats) + " testnet sats · split " + split;
  const used = me ? Number(me.used || 0) : 0;
  m.attempts = "Your attempts: " + used + " of " + max;
  const mine = me ? myBest(me, board) : null;
  m.mine = mine ? "Your best: " + fmtSats(mine.total) + (mine.rank ? " · rank " + mine.rank : "") : "Your best: no run yet";
  m.left = round.phase === "soon" ? "Opens in " + fmtLeft(round.startMs - nowMs) : "Time left: " + fmtLeft(round.endMs - nowMs);
  // the same lines as label and value, for the intro's grid
  m.facts = [["Current best", m.best, "wide"], ["Pot so far", m.pot.replace(" · split ", " · "), "wide"], [round.phase === "soon" ? "Opens in" : "Time left", m.left.replace(/^(Opens in|Time left:) /, "")],
    ["Your attempts", used + " of " + max], ["Your best", m.mine.replace(/^Your best: /, "")]];
  const label = "Play · " + fmtSats(entry) + " testnet sats";
  const off = (why) => (m.button = { label, disabled: true, why });
  const bal = wallet.balance ? Number(wallet.balance.sats) || 0 : null;
  if (round.phase === "ended") off("This round has ended.");
  else if (round.phase === "last-call") off("No new attempts in the last 5 minutes of a round.");
  else if (round.phase === "soon") off("The round opens in " + fmtLeft(round.startMs - nowMs) + ".");
  else if (round.phase !== "open") off("The round is being prepared - it opens once its level is posted on chain.");
  else if (used >= max) off("All " + max + " attempts of this round are used.");
  else if (!wallet.pubkey) off("Your Arena wallet is opening …");
  // A NEW, EMPTY WALLET PLAYS AT ONCE (kanban #3265): its welcome sats are on their way and pay the entry in the background
  else if (bal !== null && bal < entry && !wallet.welcomeComing) off("Your balance is too low: an attempt costs " + fmtSats(entry) + " testnet sats.");
  else m.button = { label, disabled: false, why: bal !== null && bal < entry ? "Your welcome sats are on their way - they pay the entry while you play." : "" };
  return m;
}

/** What the result screen says about the entry (kanban #3265). */
export function entryLine(entry, why) {
  if (entry === "paid") return { kind: "ok", text: "Entry paid - this run counts." };
  if (entry === "not-paid") return { kind: "bad", text: "Entry not paid - this run does not count." + (why ? " (" + why + ")" : "") };
  if (entry === "practice") return { kind: "", text: "Practice run - not sent." };
  return { kind: "wait", text: "Waiting for your entry - the run counts once the 100 sats are paid." };
}

/**
 * The result: { title, entry, rows: [[label, value]], total, rank, beat, left, xPrompt }.
 * res: the run (resultOf); before/after: myBest() before and after the run; me: GET /me after it.
 */
export function resultModel({ res, parTime, entry, entryWhy, before, after, me, max = 5, mode = "play", submitWhy = null }) {
  const out = {};
  out.title = mode === "replay" ? "Replay: " + (res.finished ? "flag in " + fmtTime(res.timeS) : "time is up") : res.finished ? "Flag reached in " + fmtTime(res.timeS) : "Time is up";
  out.entry = entryLine(entry, entryWhy);
  const p = res.parts || {};
  out.rows = [["Sats (coins and ₿ blocks)", p.sats], ["Shitcoins stomped × 10", p.stomps], ["Flag reached", p.goal], ["Time bonus (2 per second under " + parTime + " s)", p.time], ["Day high", p.high]];
  if (res.clean) out.rows.push(["No hits", "×1.5"]);
  out.total = res.total;
  if (mode !== "play") return out;
  if (submitWhy) out.refused = "The service did not take this run: " + submitWhy;
  out.rank = after && after.rank ? "Rank " + after.rank + " after this run" : entry === "paid" ? "Not on the board yet" : null;
  out.beat = !before ? (after ? "Your first score of the round" : null) : res.total > before.total ? "New best - you beat your " + fmtSats(before.total) : "Your best stays " + fmtSats(before.total);
  if (me) out.left = "Attempts left: " + Math.max(0, max - Number(me.used || 0)) + " of " + max;
  if (me && !me.x) out.xPrompt = "Link your X account to be placed and win.";
  else if (me && me.x && !me.placed) out.xPrompt = "Your X account " + (me.x.username ? "@" + me.x.username + " " : "") + "is linked - " + (me.placedWhy || "not verified yet") + ".";
  return out;
}

/** The leaderboard rows: [[rank, name, score, time, placed]] */
export const boardRows = (board) => (board || []).map((r) => ({ rank: String(r.rank), name: String(r.name || ""), score: fmtSats(r.score), time: fmtTime(r.timeS), placed: !!r.placed, replay: r.replay || null }));
