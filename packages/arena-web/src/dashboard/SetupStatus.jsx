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
// ONE PART OF THE SETUP AS A TILE (the owner's playtest 2026-10-25: "Also make this more pretty"): a round icon in its colour, the name,
// the state under it, a bar where there is one to fill
class Step extends React.Component {
  render() {
    const { id, label, done, problem, text, meter } = this.props;
    const st = done ? 'ok' : problem ? 'bad' : 'wait';
    return (
      <div className={`setup-step s-${st}`} id={id}>
        <span className="setup-ic" aria-hidden="true">{done ? '✓' : problem ? '!' : '…'}</span>
        <div className="setup-body"><b>{label}</b><span className="setup-text">{text}</span>
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
export function faucetLine(f, bond = null) {
  if (!f) return null;
  // the coins the bond was made from: done once that bond is on the chain, whatever the faucet's own transaction shows (playtest
  // 2026-10-25: "363,000 sat on the way ... not seen on the chain yet" beside a bond with 19 confirmations)
  if (!f.confirmations && bond && bond.seen && bond.confirmations > 0) return { done: true, text: `${n(f.sats)} sat arrived; your bond was made from them` };
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

/** The setup's rows: [id, label, line] for each part that has something to say. */
export function setupRowsOf(s) {
  if (!s || !s.ok) return [];
  return [['setup-core', 'Bitcoin Core', coreLine(s.core)], ['setup-address', 'Public address', addressLine(s.address)], ['setup-faucet', 'Test coins', faucetLine(s.faucet, s.bond)],
      ['setup-bond', 'Bond', bondLine(s.bond)], ['setup-lnd', 'LND', lndLine(s.lnd)], ['setup-gateway', 'Gateway', gatewayLine(s.gateway)], ['setup-pegin', 'Peg-in', pegInLine(s.pegIn)],
      ...(s.updates || []).map((u, i) => [`setup-update-${i}`, 'Update', updateLine(u)]),
      ...(s.oldBonds || []).map((o, i) => [`setup-old-${i}`, 'Old bond', oldBondLine(o)])].filter(([, , l]) => l);
}

export class SetupStatus extends React.Component {
  render() {
    const s = this.props.status;
    const rows = setupRowsOf(s);
    if (!rows.length) return null;
    const all = rows.every(([, , l]) => l.done);
    const problems = rows.filter(([, , l]) => l.problem).length;
    const done = rows.filter(([, , l]) => l.done).length;
    return (
      <div className="card setup-status" id="setup-status">
        <div className="setup-head"><h3>Setup</h3>
          <span className={`setup-pill ${all ? 'ok' : problems ? 'bad' : 'wait'}`}>{all ? 'Complete' : problems ? `${problems} problem${problems === 1 ? '' : 's'}` : `${done} of ${rows.length} done`}</span></div>
        <div className="setup-total" role="progressbar" aria-valuemin="0" aria-valuemax={rows.length} aria-valuenow={done}><i style={{ width: `${Math.round((100 * done) / rows.length)}%` }} /></div>
        <div className="setup-grid">{rows.map(([id, label, l]) => <Step key={id} id={id} label={label} done={l.done} problem={l.problem} text={l.text} meter={l.meter} />)}</div>
        {s.tip ? <p className="setup-tip">Chain tip · block {n(s.tip)}</p> : null}
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
  render() { return this.props.banner ? <SetupBanner status={this.state.status} /> : <SetupStatus status={this.state.status} />; }
}

/** The owner sections that help while the setup runs (a problem to fix, an update, the emergency code, the login); the rest waits for it. */
export const SETUP_OPEN_SECTIONS = Object.freeze(['overview', 'services', 'release', 'emergency', 'login']);
/**
 * THE OWNER AREA WAITS FOR THE SETUP (the owner's playtest 2026-10-25: roles and the bond did not load while Bitcoin Core synced - "make
 * sure the user knows that the node is still being set up", then: "Instead the whole owners page should show the setup screen so user
 * can't access the owners area yet, with a message. Check back when all services are synchronized", and: "those things are fine if we
 * need the owners page. Disable things that might confuse the user"): while any part of the setup is still open, a screen over the whole
 * owner area with the message and the Setup card; it lifts by itself once every part is done. When a part has a problem the owner fixes
 * here, the screen lets the owner in - to the sections that help (SETUP_OPEN_SECTIONS); the others stay off until the setup is done
 * (body[data-setup="open"], owner.html), with one line above that says why.
 */
export class SetupBanner extends React.Component {
  constructor(props) { super(props); this.state = { entered: false }; }
  componentDidMount() { this.mark(); }
  componentDidUpdate() { this.mark(); }
  componentWillUnmount() { if (typeof document !== 'undefined') delete document.body.dataset.setup; }
  enter() {
    // a section that waits for the setup is never the one shown: the Overview instead
    if (typeof location !== 'undefined' && !SETUP_OPEN_SECTIONS.includes(location.hash.slice(1))) location.hash = '#overview';
    this.setState({ entered: true });
  }
  phase() {
    const rows = setupRowsOf(this.props.status);
    if (!rows.length || rows.every(([, , l]) => l.done)) return { phase: 'done', rows };
    return { phase: this.state.entered ? 'open' : 'gate', rows };
  }
  mark() {
    if (typeof document === 'undefined') return;
    const { phase } = this.phase();
    if (phase === 'done') delete document.body.dataset.setup; else document.body.dataset.setup = phase;
  }
  render() {
    const s = this.props.status;
    const { phase, rows } = this.phase();
    if (phase === 'done') return null;
    if (phase === 'open') return (
      <div className="setup-banner" id="setup-banner" role="status"><b>Setup is still running.</b> Until it's done you can only use Overview, Services, Updates, Emergency code and Your login.</div>);
    const problems = rows.filter(([, , l]) => l.problem);
    return (
      <div className="setup-gate" id="setup-gate" role="dialog" aria-modal="true" aria-labelledby="setup-gate-title">
        <div className="setup-gate-in">
          <h2 id="setup-gate-title">Your node is still being set up</h2>
          <p className="setup-gate-msg">Check back when all services are synchronized. This page opens by itself when they are.</p>
          <SetupStatus status={s} />
          {problems.length ? <div className="setup-gate-fix"><p>{problems.map(([, label]) => label).join(' and ')} {problems.length === 1 ? 'has a problem' : 'have problems'} you can fix in the owner area.</p>
            <button type="button" id="setup-gate-enter" onClick={() => this.enter()}>Open the owner area</button></div> : null}
        </div>
      </div>);
  }
}
