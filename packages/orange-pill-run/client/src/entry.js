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
  return { ok: true, attempt: r.attempt, token: r.token || null, level: r.level || null, invoice: r.invoice || null, sats: Number(r.sats || r.entrySats || 100),
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
        if (!bal || !(Number(bal.sats) >= att.sats)) {
          const welcome = bridge && bridge.welcomeComing ? !!bridge.welcomeComing() : false;
          onStatus(welcome ? "waiting-welcome" : "waiting-balance", bal ? `${Number(bal.sats) || 0} of ${att.sats} sats` : "the wallet is opening");
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
  async function submit({ attempt, token, round, log: runLog, client }) {
    return api.post("/submit", { attempt, token, round, log: runLog, client });
  }
  /** The entry of an attempt now: { entry: 'paid'|'waiting'|'not-paid'|null, check } */
  async function entryNow(attempt) { const c = await check(attempt); return { entry: c && c.ok ? entryOf(c) : null, check: c }; }
  return { start, submit, payInBackground, waitStarted, entryNow };
}
