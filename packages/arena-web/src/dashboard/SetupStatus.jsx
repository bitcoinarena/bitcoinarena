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
/** A time left as people say it: "under a minute", "12 min", "3 h 20 min", "2 days"; '' when there is none. */
export const dur = (ms) => {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '';
  const m = Math.round(ms / 60000);
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} min`;
  if (m < 48 * 60) return m % 60 && m < 10 * 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.round(m / 60)} h`;
  return `${Math.round(m / 1440)} days`;
};
export const eta = (ms) => (ms === null || ms === undefined ? '' : ms < 3600000 ? `about ${Math.max(1, Math.round(ms / 60000))} min left` : ms < 172800000 ? `about ${Math.round(ms / 3600000)} h left` : `about ${Math.round(ms / 86400000)} days left`);

/** One line of the card: a label, the state in words, a meter. */
// ONE PART OF THE SETUP AS A TILE (the owner's playtest 2026-10-25: "Also make this more pretty"): a round icon in its colour, the name,
// the state under it, a bar where there is one to fill
class Step extends React.Component {
  render() {
    const { id, label, done, problem, later, text, meter, left } = this.props;
    const st = done ? 'ok' : problem ? 'bad' : later ? 'later' : 'wait';
    const t = !done && left ? dur(left) : '';
    return (
      <div className={`setup-step s-${st}`} id={id}>
        <span className="setup-ic" aria-hidden="true">{done ? '✓' : problem ? '!' : later ? '–' : '…'}</span>
        <div className="setup-body"><b>{label}</b><span className="setup-text">{text}</span>
          {meter !== undefined ? <div className="bar"><i style={{ width: `${meter}%` }} /></div> : null}</div>
        {t ? <span className="setup-eta">{t}</span> : null}
      </div>);
  }
}

/** The words for each part (exported for the tests). */
export function coreLine(c) {
  if (!c) return null;
  if (!c.interim) return { done: true, text: 'synced; your node reads the chain from its own Bitcoin Core' };
  const s = c.sync;
  if (!s) return { done: false, text: c.why ? `starting: ${c.why}` : 'starting' };
  return { done: false, meter: Math.round(s.progress * 100), text: `syncing, block ${n(s.blocks)} of ${n(s.headers)} (${(s.progress * 100).toFixed(1)} %). Until then your node reads the chain from a public server.` };
}
export function bondLine(b) {
  if (!b) return null;
  if (!b.seen) return { done: false, text: `${n(b.sats)} sat, ${shortTx(b.txid)}: not seen on the chain yet` };
  const need = b.needed || 6;
  if (!b.confirmations) return { done: false, meter: 0, text: `${n(b.sats)} sat, sent, 0 of ${need} confirmations. It counts at ${need} and must first confirm by block ${n(b.confirmBy)}.` };
  if (b.counts === false) return { done: false, problem: true, text: `${n(b.sats)} sat, ${n(b.confirmations)} confirmations, but it confirmed after block ${n(b.confirmBy)} and does not count. Post a new bond from the bond panel.` };
  if (b.confirmations < need) return { done: false, meter: pct(b.confirmations, need), text: `${n(b.sats)} sat, ${n(b.confirmations)} of ${need} confirmations. It counts at ${need}.` };
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
export function gatewayLine(g, founding = null, bonded = true) {
  if (!g) return null;
  // no bond, no federation (kanban #728): the gateway waits for the bond, which the Bond section sets up - nothing to do here
  if (g.ok && !(g.federations > 0) && !bonded) return { done: true, text: 'running; it joins a federation once your node has a bond' };
  // waiting for a founding is not setup (2026-10-26): done here, the founding has its own panel (FoundingWait)
  if (g.ok && !(g.federations > 0) && founding && founding.waiting) return { done: true, text: 'running; it joins your federation once that is founded' };
  if (g.ok) return { done: g.federations > 0, text: g.federations > 0 ? `running, in ${n(g.federations)} federation${g.federations === 1 ? '' : 's'}` : 'running, joining its federation' };
  return { done: false, problem: !g.syncing, text: g.syncing ? 'waiting for LND to sync. Then its peg-in needs 100 confirmations.' : `not answering: ${g.why}` };
}
/**
 * LEFT FOR LATER (kanban #711, the 2026.1.9.11 install test: "Complete" on a custody node with no LND and no gateway): not done, no problem,
 * and the way to set it up - the owner area's Services card sets the gateway up, Lightning with it. `l` the setup's `later`.
 */
export function laterLine(l, what) {
  if (!l || !l[what]) return null;
  const how = l.fix ? 'Set it up in the owner area: Services, Lightning gateway, Set up the gateway.' : l.why;
  return { done: false, later: true, text: what === 'lnd' ? `Left for later. ${how}` : `Left for later: custody needs it to serve deposits. ${how}` };
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
  const e = s.etas || {};
  const at = (l, left) => (l ? { ...l, left: left === undefined ? null : left } : l);
  return [['setup-core', 'Bitcoin Core', at(coreLine(s.core), e.core)], ['setup-address', 'Public address', addressLine(s.address)], ['setup-faucet', 'Test coins', at(faucetLine(s.faucet, s.bond), e.faucet)],
      ['setup-bond', 'Bond', at(bondLine(s.bond), e.bond)], ['setup-lnd', 'LND', s.lnd ? at(lndLine(s.lnd), e.lnd) : laterLine(s.later, 'lnd')], ['setup-gateway', 'Gateway', s.gateway ? at(gatewayLine(s.gateway, s.founding, !noBond(s)), e.gateway) : laterLine(s.later, 'gateway')], ['setup-pegin', 'Peg-in', at(pegInLine(s.pegIn), e.pegIn)],
      ...(s.updates || []).map((u, i) => [`setup-update-${i}`, 'Update', at(updateLine(u), (e.updates || [])[i])]),
      ...(s.oldBonds || []).map((o, i) => [`setup-old-${i}`, 'Old bond', oldBondLine(o)])].filter(([, , l]) => l);
}

/** The big number: how long until the node is ready, or null when it cannot be told. */
export function readyIn(s) {
  const e = s && s.etas;
  if (!e || e.ready === null || e.ready === undefined || !(e.ready > 0)) return null;
  return { text: dur(e.ready), atLeast: !!e.partial };
}

/** NO BOND (kanban #728, 2026-10-27, the owner: "Wenn kein Bond da ist, muss das deutlich sichtbar sein im Dashboard und Owner-Dashboard,
 *  und auch keine Federation-Info"): an installed node whose setup names no bond posted - the installer's "I'll post it later". */
export const noBond = (s) => !!(s && s.ok && !s.bond);
/** The red card on both dashboards: no bond, so no rounds - and the one thing to do, set it up in the owner area's Bond section (`href`). */
export function NoBondCard({ status: s, href }) {
  if (!noBond(s)) return null;
  return (
    <div className="card no-bond" id="no-bond" style={{ borderColor: '#f85149' }}>
      <div className="setup-head"><h3>No bond</h3><span className="setup-pill bad">Not drawn for rounds</span></div>
      <p>Your node needs a bond before it is drawn for rounds and earns.</p>
      <a className="btn primary" id="no-bond-go" href={href}>Set up the bond</a>
    </div>);
}

/** THE FOUNDING THE NODE WAITS FOR, apart from the setup (2026-10-26, the owner: "setup is complete but a separate header that it's waiting for
 *  the foundation"): no time is promised - a founding needs ten ready nodes drawn together. */
export function FoundingWait({ status: s }) {
  if (!s || !s.founding || !s.founding.waiting || noBond(s)) return null;
  return (
    <div className="card founding-wait" id="founding-wait">
      <div className="setup-head"><h3>Federation</h3><span className="setup-pill wait">Waiting for a founding</span></div>
      {/* HOW MANY ARE READY, BIG (2026-10-26, the owner: "how many other nodes are waiting in the format e.g 3/10 ... in big letters") */}
      {Number.isFinite(s.founding.ready) && s.founding.needed ? <div className="founding-count" id="founding-count">
        <span className="founding-n">{s.founding.ready}/{s.founding.needed}</span><span className="founding-l">nodes ready for the next federation</span></div> : null}
      <p>Your node waits to be drawn into a new federation. {s.founding.needed || 'Ten'} ready nodes found one together, so this can take a while; there is no fixed time.</p>
      <p className="dim">Meanwhile your node runs as usual: it checks rounds and earns its share. Its guardian and its gateway join the new federation as soon as it is founded.{s.founding.sinceMs ? ` Waiting since ${new Date(s.founding.sinceMs).toISOString().slice(0, 16).replace('T', ' ')} UTC.` : ''}</p>
    </div>);
}

// A COMPLETE SETUP HIDDEN ON THIS DEVICE (2026-10-26, the owner: "Setup needs a Don't show again link if it's complete so it's hidden on the
// device (stored in browser)"): kept per node in this browser; a step that stops being done brings the card back by itself
export const SETUP_HIDDEN = 'arena-setup-hidden';
const hiddenFor = (node) => { try { return !!node && localStorage.getItem(`${SETUP_HIDDEN}:${node}`) === '1'; } catch { return false; } };

export class SetupStatus extends React.Component {
  constructor(props) { super(props); this.state = { hidden: hiddenFor(this.nodeOf(props)) }; }
  nodeOf(props = this.props) { return props.node || (props.status && props.status.node) || null; }
  hide() { try { localStorage.setItem(`${SETUP_HIDDEN}:${this.nodeOf()}`, '1'); } catch { /* storage blocked: hidden until the page reloads */ } this.setState({ hidden: true }); }
  // AND BACK (kanban #849: the choice could not be undone)
  show() { try { localStorage.removeItem(`${SETUP_HIDDEN}:${this.nodeOf()}`); } catch { /* storage blocked: shown until the page reloads */ } this.setState({ hidden: false }); }
  render() {
    const s = this.props.status;
    const rows = setupRowsOf(s);
    if (!rows.length) return null;
    const all = rows.every(([, , l]) => l.done);
    if (all && (this.state.hidden || hiddenFor(this.nodeOf()))) return <p className="setup-tip"><button type="button" className="setup-hide" onClick={() => this.show()}>Show setup</button></p>;
    const problems = rows.filter(([, , l]) => l.problem).length;
    const done = rows.filter(([, , l]) => l.done).length;
    // ONLY WHAT WAS LEFT FOR LATER IS OPEN (kanban #711): said so, not "Complete" and not "n of m done"
    const onlyLater = !all && rows.every(([, , l]) => l.done || l.later);
    const ready = readyIn(s);
    return (
      <div className="card setup-status" id="setup-status">
        <div className="setup-head"><h3>Setup</h3>
          <span className={`setup-pill ${all ? 'ok' : problems ? 'bad' : 'wait'}`}>{all ? 'Complete' : problems ? `${problems} problem${problems === 1 ? '' : 's'}` : onlyLater ? 'Lightning left for later' : `${done} of ${rows.length} done`}</span></div>
        {!all && ready ? <div className="setup-ready" id="setup-ready"><span className="setup-ready-n">{ready.atLeast ? 'at least ' : ''}{ready.text}</span>
          <span className="setup-ready-l">until your node is ready</span></div> : null}
        <div className="setup-total" role="progressbar" aria-valuemin="0" aria-valuemax={rows.length} aria-valuenow={done}><i style={{ width: `${Math.round((100 * done) / rows.length)}%` }} /></div>
        <div className="setup-grid">{rows.map(([id, label, l]) => <Step key={id} id={id} label={label} done={l.done} problem={l.problem} later={l.later} text={l.text} meter={l.meter} left={l.left} />)}</div>
        {s.tip || (all && this.nodeOf()) ? <p className="setup-tip">{s.tip ? <>Chain tip · block {n(s.tip)}{s.blockMs && s.blockMsMeasured ? ` · lately a block every ${dur(s.blockMs)}` : ''}</> : null}
          {all && this.nodeOf() ? <button type="button" className="setup-hide" onClick={() => this.hide()}>Don't show again</button> : null}</p> : null}
      </div>);
  }
}

// THE PEG-IN, PROMINENT (2026-10-26, the owner: "It needs to show the status of the peg in prominently if we have a peg in"): the gateway's
// coins moving into its federation, by their confirmations against the federation's finality, big - until they are credited
export function PegInCard({ status: s }) {
  const p = s && s.pegIn;
  if (!p || !p.txid) return null;
  const c = Math.max(0, Number(p.confirmations) || 0), need = Number(p.needed) || 100, done = !!p.credited || c >= need;
  return (
    <div className="card pegin-card" id="pegin-card">
      <div className="setup-head"><h3>Peg-in</h3><span className={`setup-pill ${done ? 'ok' : 'wait'}`}>{done ? 'Credited' : p.seen ? 'Confirming' : 'Waiting to be mined'}</span></div>
      <div className="founding-count"><span className={`founding-n${done ? ' ok' : ''}`}>{Math.min(c, need)}/{need}</span><span className="founding-l">confirmations{p.sats ? ` · ${n(p.sats)} sat into the federation for your gateway` : ''}</span></div>
      <div className="setup-total" role="progressbar" aria-valuemin="0" aria-valuemax={need} aria-valuenow={Math.min(c, need)}><i style={{ width: `${Math.min(100, Math.round((100 * c) / need))}%` }} /></div>
      <p className="dim">{done ? 'Your gateway holds its e-cash and can serve deposits and withdrawals.' : `About ${dur((need - c) * (s.blockMs || 600000))} to go. Transaction ${String(p.txid).slice(0, 12)}…`}</p>
    </div>);
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
  render() { return this.props.banner ? <SetupBanner status={this.state.status} /> : <><NoBondCard status={this.state.status} href="#bond" /><PegInCard status={this.state.status} /><SetupStatus status={this.state.status} /><FoundingWait status={this.state.status} /></>; }
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
    // AN UPDATE IS NO SETUP (2026-10-26, the owner on "Your node is still being set up - Update: the roles change: 0 of 6 confirmations":
    // "When it is just doing an update because a transaction was sent, no need to lock the entire screen. The full owner dashboard remains
    // available"): an advertisement update on its way never closes the owner area; the Overview's Setup card shows it
    // NOR WHAT WAS LEFT FOR LATER (kanban #711): Lightning the owner chose to set up later never closes the owner area - it is set up there
    // NOR THE BOND (kanban #728, the 2026.1.9.11 install test: a bond posted from the Bond section closed the whole owner area behind
    // "still being set up" until it had 6 confirmations - the Bond section itself among the sections it shut): the bond is made and
    // watched in the owner area, never a reason to close it
    const setup = rows.filter(([id, , l]) => !String(id).startsWith('setup-update-') && id !== 'setup-bond' && !l.later);
    if (!setup.length || setup.every(([, , l]) => l.done)) return { phase: 'done', rows };
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
          <h2 id="setup-gate-title">Your node is still being set up{s && s.release && s.release.version ? <span className="ver" id="setup-gate-ver">{s.release.version}</span> : null}</h2>
          <p className="setup-gate-msg">Check back when everything below is synced.</p>
          <SetupStatus status={s} />
          {problems.length ? <div className="setup-gate-fix"><p>{problems.map(([, label]) => label).join(' and ')} {problems.length === 1 ? 'has a problem' : 'have problems'} you can fix in the owner area.</p>
            <button type="button" id="setup-gate-enter" onClick={() => this.enter()}>Open the owner area</button></div> : null}
        </div>
      </div>);
  }
}
