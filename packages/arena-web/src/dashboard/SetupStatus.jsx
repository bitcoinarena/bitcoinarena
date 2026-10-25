// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SETUP'S PROGRESS, ON BOTH DASHBOARDS (kanban #635, 2026-10-25: "in dem public Node Dashboard ein Panel einblenden mit dem
// Status der node anzeigen wieviel confirmations Bond und peg in haben. Das selbe auch beim owner Dashboard"): the installer posts the bond
// and the rest without waiting, so this card says how far each is - Bitcoin Core's background sync, the bond's confirmations and whether it
// counts, the peg-in's confirmations against the federation's finality - and (2026-10-25: "lnd status and everything else that may be
// in progress") LND, the gateway, the public address, the faucet's coins, advertisement updates and old bonds to take back. Drawn from
// GET /setup-status; nothing when there is nothing to show.
import React from 'react';

const n = (x) => Number(x || 0).toLocaleString('en-US');
const shortTx = (t) => `${String(t).slice(0, 12)}…`;
const pct = (a, b) => Math.max(0, Math.min(100, b ? Math.round((100 * a) / b) : 0));
/** "about 3 h" for an ETA in ms; '' when there is none yet. */
export const eta = (ms) => (ms === null || ms === undefined ? '' : ms < 3600000 ? `about ${Math.max(1, Math.round(ms / 60000))} min left` : ms < 172800000 ? `about ${Math.round(ms / 3600000)} h left` : `about ${Math.round(ms / 86400000)} days left`);

/** One line of the card: a label, the state in words, a meter. */
class Step extends React.Component {
  render() {
    const { id, label, done, problem, text, meter } = this.props;
    return (
      <div className="setup-step" id={id}>
        <span className={done ? 'ok' : problem ? 'bad' : 'wait'}>{done ? '✓' : problem ? '!' : '○'}</span>
        <div><b>{label}</b> <span className="sub">{text}</span>
          {meter !== undefined ? <div className="bar"><i style={{ width: `${meter}%` }} /></div> : null}</div>
      </div>);
  }
}

/** The words for each part (exported for the tests). */
export function coreLine(c) {
  if (!c) return null;
  if (!c.interim) return { done: true, text: 'synced; your node reads the chain from its own Bitcoin Core' };
  const s = c.sync;
  if (!s) return { done: false, text: c.why ? `starting: ${c.why}` : 'starting' };
  return { done: false, meter: Math.round(s.progress * 100), text: `syncing, block ${n(s.blocks)} of ${n(s.headers)} (${(s.progress * 100).toFixed(1)} %)${eta(s.etaMs) ? `, ${eta(s.etaMs)}` : ''}. Until then your node reads the chain from a public server.` };
}
export function bondLine(b) {
  if (!b) return null;
  if (!b.seen) return { done: false, text: `${n(b.sats)} sat, ${shortTx(b.txid)}: not seen on the chain yet` };
  if (!b.confirmations) return { done: false, meter: 0, text: `${n(b.sats)} sat, sent, waiting for its first confirmation. It must confirm by block ${n(b.confirmBy)} to count.` };
  if (b.counts === false) return { done: false, text: `${n(b.sats)} sat, ${n(b.confirmations)} confirmations, but it confirmed after block ${n(b.confirmBy)} and does not count. Post a new bond from the bond panel.` };
  return { done: true, text: `${n(b.sats)} sat, ${n(b.confirmations)} confirmation${b.confirmations === 1 ? '' : 's'}. It counts; locked for ${n(b.blocksToMaturity)} more blocks.` };
}
export function pegInLine(p) {
  if (!p) return null;
  if (!p.seen) return { done: false, text: `${n(p.sats)} sat, ${shortTx(p.txid)}: not seen on the chain yet` };
  if (p.credited) return { done: true, text: `${n(p.sats)} sat, ${n(p.confirmations)} confirmations: the federation has credited it` };
  return { done: false, meter: pct(p.confirmations, p.needed), text: `${n(p.sats)} sat, ${n(p.confirmations)} of ${n(p.needed)} confirmations. The federation credits it at ${n(p.needed)}.` };
}

export function lndLine(l) {
  if (!l) return null;
  if (!l.ok) return { done: false, problem: true, text: `not answering: ${l.why}` };
  if (!l.synced) return { done: false, text: `running, catching up with the chain (block ${n(l.height)})` };
  const ch = l.channels === null ? '' : `, ${n(l.channels)} open channel${l.channels === 1 ? '' : 's'}${l.pending ? `, ${n(l.pending)} opening` : ''}`;
  // how other Lightning nodes reach it: an open port, Tor's onion address, or not at all (then it only dials out: a problem for custody)
  const v = l.via || null;
  const reach = !v ? '' : v.how === 'direct' ? `; reached directly at ${v.at}` : v.how === 'tor' ? `; reached over Tor (no open port needed)` : `; other nodes cannot reach it${v.why ? ` (${v.why})` : ''}`;
  return { done: !l.pending && (!v || v.how !== 'none'), problem: !!v && v.how === 'none', text: `synced at block ${n(l.height)}${ch}${reach}` };
}
export function gatewayLine(g) {
  if (!g) return null;
  if (g.ok) return { done: g.federations > 0, text: g.federations > 0 ? `running, in ${n(g.federations)} federation${g.federations === 1 ? '' : 's'}` : 'running, joining its federation' };
  return { done: false, problem: !g.syncing, text: g.syncing ? 'waiting for LND to sync' : `not answering: ${g.why}` };
}
export function addressLine(a) {
  if (!a) return null;
  return a.ok ? { done: true, text: `others reach your node at ${a.url}` } : { done: false, problem: true, text: `${a.url} does not answer as your node (${a.why})` };
}
export function faucetLine(f) {
  if (!f) return null;
  if (!f.seen) return { done: false, text: `${n(f.sats)} sat on the way, ${shortTx(f.txid)}: not seen on the chain yet` };
  return { done: f.confirmations > 0, text: f.confirmations ? `${n(f.sats)} sat arrived, ${n(f.confirmations)} confirmation${f.confirmations === 1 ? '' : 's'}` : `${n(f.sats)} sat arrived, waiting for its first confirmation` };
}
export function updateLine(u) {
  if (!u.seen) return { done: false, text: `${u.what}: sent, ${shortTx(u.txid)}, not seen on the chain yet` };
  if (u.counts) return { done: true, text: `${u.what}: ${n(u.confirmations)} confirmations, in force` };
  return { done: false, meter: pct(u.confirmations, u.needed), text: `${u.what}: ${n(u.confirmations)} of ${n(u.needed)} confirmations, in force at ${n(u.needed)}` };
}
export function oldBondLine(o) {
  return o.back ? { done: false, text: `${n(o.sats)} sat under your old key: unlocked, take it back from the bond panel` }
    : { done: true, text: `${n(o.sats)} sat under your old key, locked for ${n(o.blocksLeft)} more blocks (until block ${n(o.maturity)}), then yours to take back` };
}

export class SetupStatus extends React.Component {
  render() {
    const s = this.props.status;
    if (!s || !s.ok) return null;
    const rows = [['setup-core', 'Bitcoin Core', coreLine(s.core)], ['setup-address', 'Public address', addressLine(s.address)], ['setup-faucet', 'Test coins', faucetLine(s.faucet)],
      ['setup-bond', 'Bond', bondLine(s.bond)], ['setup-lnd', 'LND', lndLine(s.lnd)], ['setup-gateway', 'Gateway', gatewayLine(s.gateway)], ['setup-pegin', 'Peg-in', pegInLine(s.pegIn)],
      ...(s.updates || []).map((u, i) => [`setup-update-${i}`, 'Update', updateLine(u)]),
      ...(s.oldBonds || []).map((o, i) => [`setup-old-${i}`, 'Old bond', oldBondLine(o)])].filter(([, , l]) => l);
    if (!rows.length) return null;
    const all = rows.every(([, , l]) => l.done);
    const problems = rows.filter(([, , l]) => l.problem).length;
    return (
      <div className="card setup-status" id="setup-status">
        <h3>Setup {all ? <span className="ok">complete</span> : problems ? <span className="bad">{problems} need{problems === 1 ? 's' : ''} attention</span> : <span className="sub">in progress</span>}</h3>
        {rows.map(([id, label, l]) => <Step key={id} id={id} label={label} done={l.done} problem={l.problem} text={l.text} meter={l.meter} />)}
        {s.tip ? <p className="sub">Chain tip: block {n(s.tip)}</p> : null}
      </div>);
  }
}

/**
 * THE SETUP CARD ON THE OWNER'S OVERVIEW (the owner's playtest 2026-10-25, the dashboard's Setup card: "das soll auch in der owners area
 * eingefügt werden"): GET /setup-status read at once and every 30 s while anything is still in progress; nothing once all is done.
 */
export class SetupCard extends React.Component {
  constructor(props) { super(props); this.state = { status: props.initial || null }; this.load = this.load.bind(this); }
  componentDidMount() { return this.load(); }
  componentWillUnmount() { this.gone = true; clearTimeout(this.timer); }
  async load() {
    if (this.gone || !this.props.api) return;
    let s = null; try { s = await this.props.api.get('/setup-status'); } catch { s = null; }
    if (this.gone) return;
    this.setState({ status: s });
    clearTimeout(this.timer); this.timer = setTimeout(this.load, this.props.everyMs || 30000);
  }
  render() { return <SetupStatus status={this.state.status} />; }
}
