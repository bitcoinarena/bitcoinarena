// A FEDERATION'S ON-CHAIN RESERVE (spec §23A.3, kanban #324: "Custody held is public. A federation's reserve is its on-chain
// wallet"; load = reserve / exposure_cap). Read from its guardians' stock wallet module: each guardian's public
// `wallet_summary` over its JSON-RPC WebSocket (the API the stock client uses), and kept only when at least `threshold`
// guardians answer the same sum - one guardian cannot move the number. The reserve is the federation's own coins: the
// spendable UTXOs and its change not yet confirmed or signed; peg-outs on their way out are not.
const sumOf = (list) => (list || []).reduce((t, u) => t + BigInt(u.amount || 0), 0n);
export const reserveOfSummary = (s) => sumOf(s.spendable_utxos) + sumOf(s.unconfirmed_change_utxos) + sumOf(s.unsigned_change_utxos);

/** One guardian's wallet summary: the wallet module found by trying the module ids (the first to answer the method). */
async function askOne(endpoint, { timeoutMs, moduleId, WS }) {
  return new Promise((done) => {
    let ws; const finish = (v) => { try { ws && ws.close(); } catch { /* closed */ } done(v); };
    const timer = setTimeout(() => finish({ ok: false, why: 'no answer in time' }), timeoutMs);
    try { ws = new WS(endpoint); } catch (e) { clearTimeout(timer); done({ ok: false, why: e.message }); return; }
    const ids = moduleId !== null && moduleId !== undefined ? [moduleId] : [0, 1, 2, 3, 4, 5, 6, 7];
    let left = ids.length;
    ws.addEventListener('open', () => { for (const id of ids) ws.send(JSON.stringify({ jsonrpc: '2.0', id, method: `module_${id}_wallet_summary`, params: [{ auth: null, params: null }] })); });
    ws.addEventListener('message', (e) => {
      let j; try { j = JSON.parse(String(e.data)); } catch { return; }
      if (j.result && Array.isArray(j.result.spendable_utxos)) { clearTimeout(timer); finish({ ok: true, moduleId: j.id, reserveSats: reserveOfSummary(j.result) }); return; }
      if (--left <= 0) { clearTimeout(timer); finish({ ok: false, why: 'no wallet module answered wallet_summary' }); }
    });
    ws.addEventListener('error', () => { clearTimeout(timer); finish({ ok: false, why: 'the connection failed' }); });
  });
}

/**
 * THE RESERVE, BY A THRESHOLD OF GUARDIANS: every endpoint asked at once; the sum at least `threshold` of them name, or a
 * refusal naming what they said. `{ ok, reserveSats, agreeing, of, moduleId }`.
 */
export async function readReserve({ endpoints, threshold, timeoutMs = 8000, moduleId = null, WS = globalThis.WebSocket }) {
  const said = await Promise.all(endpoints.map((e) => askOne(e, { timeoutMs, moduleId, WS })));
  const counts = new Map();
  for (const s of said) if (s.ok) counts.set(String(s.reserveSats), (counts.get(String(s.reserveSats)) || 0) + 1);
  const [best, n] = [...counts].sort((a, b) => b[1] - a[1])[0] || [null, 0];
  if (best === null || n < threshold)
    return { ok: false, why: `${n} of ${endpoints.length} guardians named one reserve, and ${threshold} must`, of: endpoints.length, agreeing: n };
  return { ok: true, reserveSats: BigInt(best), agreeing: n, of: endpoints.length, moduleId: (said.find((s) => s.ok) || {}).moduleId ?? null };
}
