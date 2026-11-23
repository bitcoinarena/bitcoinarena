// Orange Pill Run - an attempt's entry, paid in the background (kanban #3265). No DOM. The run starts at once from POST /attempt (the level and a
// provisional token come with the 100-sat invoice); the invoice is paid from the player's Arena wallet (the page's pay-an-invoice path, through
// the bridge) as soon as the balance covers it - a new wallet waits for its faucet welcome. The run is scored only once the entry settles before
// the attempt's deadline; the result screen says which: paid / waiting / not paid.
// A service that still answers the older way (an invoice first, the level only once paid) is served too: the entry is paid, then the run starts.

/** What an attempt's answer says about its entry: 'paid' | 'waiting' | 'not-paid' | null (not known from this answer). */
export function entryOf(a) {
  if (!a || typeof a !== "object") return null;
  const e = String(a.entry || a.entryState || "").toLowerCase();
  if (e === "paid" || e === "settled") return "paid";
  if (e === "pending" || e === "waiting" || e === "pending-entry" || e === "open") return "waiting";
  if (e === "not-paid" || e === "unpaid" || e === "expired" || e === "entry-not-paid" || e === "canceled") return "not-paid";
  if (a.paid === true) return "paid";
  const s = String(a.state || "").toLowerCase();
  if (s === "entry-not-paid" || s === "expired" || s === "not-paid" || s === "unpaid" || s === "void") return "not-paid";
  // the service's own word (#3265 server: paid: false on a run still waiting for its entry, a refused run's included)
  if (a.paid === false) return "waiting";
  if (s === "pending-entry" || s === "invoiced" || s === "submitted" || s === "pending" || s === "awaiting") return "waiting";
  if (s === "started" || s === "scored" || s === "rejected" || s === "timeout") return "paid";
  return null;
}

/** POST /attempt's answer, in one shape: { ok, attempt, token, level, invoice, sats, expiresMs, deadlineMs, state, why, again } */
export function attemptOf(r) {
  if (!r || !r.ok) return { ok: false, why: (r && r.why) || "the round service did not answer" };
  return { ok: true, attempt: r.attempt, token: r.token || null, level: r.level || null, invoice: r.invoice || null, free: !!r.free, sats: r.free ? 0 : Number(r.sats || r.entrySats || 100),
    expiresMs: Number(r.expiresMs || 0) || null, deadlineMs: Number(r.deadlineMs || 0) || null, state: r.state || (r.token ? "pending-entry" : "invoiced"), again: !!r.again };
}

export function createEntry({ api, bridge, now = () => Date.now(), sleep = (ms) => new Promise((ok) => setTimeout(ok, ms)), log = () => {}, store = null } = {}) {
  const sent = new Set();
  const key = (inv) => "opr.entry.sent." + String(inv).slice(-24);
  const wasSent = (inv) => { if (sent.has(inv)) return true; try { return !!(store && store.getItem(key(inv))); } catch { return false; } };
  const markSent = (inv) => { sent.add(inv); try { if (store) store.setItem(key(inv), String(now())); } catch { /* kept in memory */ } };
  const check = (attempt) => api.post("/attempt/check", { attempt });

  /** Pays `att.invoice` once the wallet holds `att.sats`; resolves 'paid' | 'not-paid' | 'stopped' | 'gave-up'. onStatus(kind, why) tells the screen. */
  function payInBackground(att, { onStatus = () => {}, stopAt = null, pollMs = 3000, retryMs = 8000 } = {}) {
    let stopped = false;
    const until = stopAt || att.deadlineMs || att.expiresMs || now() + 15 * 60000;
    const done = (async () => {
      while (!stopped && now() < until) {
        const c = await check(att.attempt);
        const e = entryOf(c);
        if (c && c.ok && e === "paid" && !/invoiced|pending/.test(String(c.state))) { onStatus("paid"); return "paid"; }
        if (c && c.ok && e === "not-paid") { onStatus("not-paid", c.why || null); return "not-paid"; }
        if (wasSent(att.invoice)) { onStatus("confirming"); await sleep(pollMs); continue; }
        const bal = bridge && bridge.balance ? bridge.balance() : null;
        // #3251: what ONE federation can send after the fees (payable) when the page has read it, else the most one federation holds
        // and never more than the best federation holds less the gateway's fee (3 sat taken at least: screens.js FEE_GUESS_SATS)
        const top = !bal ? 0 : Number(bal.best != null ? bal.best : bal.sats) || 0;
        const can = !bal ? 0 : Math.min(top - 3, bal.payable != null ? Number(bal.payable) : Infinity);
        if (!bal || !(can >= att.sats)) {
          const welcome = bridge && bridge.welcomeComing ? !!bridge.welcomeComing() : false;
          onStatus(welcome ? "waiting-welcome" : "waiting-balance", bal ? `${can || 0} of ${att.sats} sats` : "the wallet is opening");
          await sleep(pollMs); continue;
        }
        onStatus("paying");
        let r;
        try { r = await bridge.pay(att.invoice); } catch (e) { r = { ok: false, why: (e && e.message) || String(e) }; }
        if (r && r.ok) { markSent(att.invoice); log(`entry ${String(att.attempt).slice(0, 8)} paid by ${r.by || "the wallet"}`); onStatus("confirming"); await sleep(1500); continue; }
        // an invoice that is paid already is not paid twice: the next check says so
        if (r && /already (been )?paid|already settled|invoice is already/i.test(String(r.why))) { markSent(att.invoice); continue; }
        onStatus("pay-failed", (r && r.why) || "not paid");
        await sleep(retryMs);
      }
      return stopped ? "stopped" : "gave-up";
    })();
    return { done, stop: () => { stopped = true; } };
  }

  /** The older service: the run starts once the entry is paid; resolves the started check { token, level, deadlineMs } or { ok: false }. */
  async function waitStarted(att, { onStatus = () => {}, pollMs = 2000 } = {}) {
    const pay = payInBackground(att, { onStatus, pollMs });
    const until = att.expiresMs ? att.expiresMs + 60000 : now() + 11 * 60000;
    try {
      while (now() < until) {
        const c = await check(att.attempt);
        if (c && c.ok && c.state === "started" && c.token && c.level) return { ok: true, token: c.token, level: c.level, deadlineMs: c.deadlineMs || null };
        if (c && c.ok && entryOf(c) === "not-paid") return { ok: false, why: "the entry was not paid in time" };
        await sleep(pollMs);
      }
      return { ok: false, why: "the entry was not paid in time" };
    } finally { pay.stop(); }
  }

  async function start(round) {
    const r = attemptOf(await api.post("/attempt", round ? { round } : {}));
    return r;
  }
  // A RUN IS SENT UNTIL THE SERVICE ANSWERS (kanban #3387: a real player's run of round 6 never reached the service and timed out): the run
  // is kept in the browser (store, opr.unsent) before the first POST /submit, sent again while no answer comes (no connection, a 5xx, 429)
  // until the attempt's deadline, and sent again after a reload (resendUnsent); the service's answer, yes or no, ends it
  const UNSENT = "opr.unsent";
  const unsent = () => { try { const v = JSON.parse((store && store.getItem(UNSENT)) || "[]"); return Array.isArray(v) ? v.filter((u) => u && u.attempt && u.token) : []; } catch { return []; } };
  const keepUnsent = (list) => { try { if (store) store.setItem(UNSENT, JSON.stringify(list.slice(-3))); } catch { /* kept in memory only */ } };
  const dropUnsent = (attempt) => { const l = unsent(); if (l.some((u) => u.attempt === attempt)) keepUnsent(l.filter((u) => u.attempt !== attempt)); };
  const answered = (r) => !!r && (r.ok === true || (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429));
  async function sendKept(job, { waits = [1000, 2000, 4000, 8000], onRetry = () => {} } = {}) {
    const until = job.deadlineMs || now() + 10 * 60000;
    let r = null;
    for (let i = 0; ; i++) {
      r = await api.post("/submit", { attempt: job.attempt, token: job.token, round: job.round, log: job.log, client: job.client });
      if (answered(r)) break;
      const w = waits[Math.min(i, waits.length - 1)];
      if (i >= 40 || now() + w >= until) break;
      onRetry(i + 1, r && r.why);
      await sleep(w);
    }
    if (answered(r) || now() >= until) dropUnsent(job.attempt);
    return r;
  }
  async function submit({ attempt, token, round, log: runLog, client, deadlineMs = null, player = null }, opts = {}) {
    const job = { attempt, token, round, log: runLog, client, deadlineMs, player };
    keepUnsent([...unsent().filter((u) => u.attempt !== attempt), job]);
    return sendKept(job, opts);
  }
  /** After a reload: the kept runs of this key still in time, sent again; [{ attempt, round, r }] */
  async function resendUnsent(player) {
    const out = [];
    for (const u of unsent()) {
      if (u.player && player && u.player !== player) continue;
      if (u.deadlineMs && now() > u.deadlineMs) { dropUnsent(u.attempt); continue; }
      out.push({ attempt: u.attempt, round: u.round, r: await sendKept(u, { waits: [2000, 4000] }) });
    }
    return out;
  }
  /** The entry of an attempt now: { entry: 'paid'|'waiting'|'not-paid'|null, check } */
  async function entryNow(attempt) { const c = await check(attempt); return { entry: c && c.ok ? entryOf(c) : null, check: c }; }
  return { start, submit, resendUnsent, payInBackground, waitStarted, entryNow };
}
