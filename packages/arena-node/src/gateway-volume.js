// A GATEWAY'S ROUTED VOLUME, READ FROM ITS FEDERATION (spec §23A.9, kanban #471): the LNv2 module streams every incoming contract it
// holds (`await_incoming_contracts`, public - the call a client makes for lnurl receives), and each contract's `refund_pk` is the
// key of the gateway that funded it: that gateway's `module_public_key` in its routing_info (measured 2026-10-18 on federation A:
// refund_pk 03545b94… = gateway lnd-testnet4-b's module_public_key). So a guardian counts, per gateway, the msat of the incoming
// contracts it funded - Lightning paid into the federation through it. Outgoing contracts have no such stream and are not counted.
// The call waits while there is nothing after `from`: an answer that does not come within `timeoutMs` means "nothing newer".
export const INCOMING_BATCH = 1024;   // the module's MAX_INCOMING_CONTRACTS_BATCH

function rpc(url, method, params, { timeoutMs, WS }) {
  return new Promise((ok) => {
    let ws;
    try { ws = new WS(url); } catch (e) { ok({ error: e.message }); return; }
    const t = setTimeout(() => { try { ws.terminate ? ws.terminate() : ws.close(); } catch { /* gone */ } ok({ timeout: true }); }, timeoutMs);
    const done = (x) => { clearTimeout(t); try { ws.close(); } catch { /* gone */ } ok(x); };
    ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [{ auth: null, params }] }));
    ws.onmessage = (m) => { try { done(JSON.parse(typeof m.data === 'string' ? m.data : String(m.data))); } catch (e) { done({ error: e.message }); } };
    ws.onerror = (e) => done({ error: (e && e.message) || 'websocket error' });
  });
}

/** The LNv2 module's instance id in the federation's client config. */
export async function lnv2ModuleId(url, { timeoutMs = 8000, WS = globalThis.WebSocket } = {}) {
  const r = await rpc(url, 'client_config', null, { timeoutMs, WS });
  const mods = (r.result && r.result.modules) || {};
  const hit = Object.entries(mods).find(([, m]) => m && m.kind === 'lnv2');
  return hit ? Number(hit[0]) : null;
}

/**
 * The incoming contracts after stream index `from`: { ok, contracts: [{ amountMsat (BigInt), refundPk }], next } - `next` the index
 * to ask from next time (unchanged when nothing is newer).
 */
export async function incomingSince({ url, moduleId, from = 0, timeoutMs = 5000, WS = globalThis.WebSocket }) {
  const contracts = [];
  let at = from;
  for (;;) {
    const r = await rpc(url, `module_${moduleId}_await_incoming_contracts`, [at, INCOMING_BATCH], { timeoutMs, WS });
    if (r.timeout) break;                                          // nothing after `at`
    if (r.error || !Array.isArray(r.result)) return { ok: false, why: `await_incoming_contracts: ${JSON.stringify(r.error || r).slice(0, 200)}`, contracts, next: at };
    const [list, next] = r.result;
    for (const c of list || []) {
      const m = c && c.commitment;
      if (m && /^0[23][0-9a-f]{64}$/.test(m.refund_pk || '') && Number.isSafeInteger(m.amount)) contracts.push({ amountMsat: BigInt(m.amount), refundPk: m.refund_pk });
    }
    if (!Number.isSafeInteger(next) || next <= at) break;
    at = next;
    if ((list || []).length < INCOMING_BATCH) break;
  }
  return { ok: true, contracts, next: at };
}
