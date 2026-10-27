// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER DASHBOARD'S ROLES, IN REACT (kanban #564, first screen ported; the tiles of kanban #563, 2026-10-21: "vamp it up so it
// looks modern"). A class component: what the node does read from its seat (GET /roles, /guardian, /gateway-claim, /liquidity-claim), one
// tile per role, a switch where the role is changed from here, the save bar once something changed, then the fee and Confirm
// (POST /owner/roles, signed by the owner). `api` = { get(path), post(path, body), signed(action, args) }; `node` the node's key.
import React from 'react';
import { Tile, Switch, Button, SaveBar } from '../design/components.jsx';

/** The roles the node's advertisement names, a switch each; custody is its guardian_capable flag. */
export const ROLE_SWITCHES = Object.freeze([['play', ['game', 'verify']], ['audit', ['audit']], ['settlement', ['settlement']], ['relay', ['relay']]]);
// relay is no switch: every node serves round data, always on (2026-10-26: "It should always be on")
export const SWITCHABLE = Object.freeze(['play', 'audit', 'settlement', 'custody']);

/** What is on now, from the node's census row. */
export function switchesOf(mine) {
  const has = (r) => !!(mine && (mine.roles || []).includes(r));
  return { play: has('verify') || has('game'), audit: has('audit'), settlement: has('settlement'), relay: true, custody: !!(mine && mine.guardianCapable) };
}
/** The switches the owner changed. */
export const changedOf = (was, now) => SWITCHABLE.filter((k) => !!was[k] !== !!now[k]);
/** What /owner/roles is asked for. */
export const askOf = (now) => ({ roles: ROLE_SWITCHES.filter(([k]) => now[k]).flatMap(([, rs]) => rs), custody: !!now.custody });

// MANAGE GOES WHERE IT IS SET UP (2026-10-26, the owner: "Clicking Manage on Lightning Gateway, and clicking Manage on Liquidity Provider
// doesn't do anything. It should go to the sections where those items can be configured"): the links named card ids (#custody,
// #liquidity), not sections, so the owner area stayed on its first section. `section:card` - the section opened, then its card scrolled to
// (after the section's own scroll to the top)
export const goTo = (target) => (e) => {
  const [section, card] = String(target).split(':');
  if (e && e.preventDefault) e.preventDefault();
  if (typeof location !== 'undefined' && location.hash.slice(1) !== section) location.hash = section;
  setTimeout(() => { const el = typeof document !== 'undefined' && document.getElementById(card || section); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 120);
};

/** What a running gateway without a seat waits for, in the order it comes: its federation's founding, then its peg-in. */
export function gatewayWaitsFor(s) {
  const f = s && s.founding, p = s && s.pegIn;
  if (f && f.waiting) return `Waiting for its federation to be founded${Number.isFinite(f.ready) && f.needed ? `: ${f.ready} of ${f.needed} nodes ready` : ''}. Then it pegs in and takes the gateway seat.`;
  if (p && p.txid && !p.credited) return `Waiting for its peg-in: ${Math.min(Number(p.confirmations) || 0, Number(p.needed) || 100)} of ${Number(p.needed) || 100} confirmations. Then it takes the gateway seat.`;
  if (p && p.credited) return 'Its peg-in is credited: it takes the gateway seat at the next seating of its federation.';
  return 'Installed and running: it takes its federation\'s gateway seat once the federation is founded and its peg-in counts.';
}

export class RolesPanel extends React.Component {
  constructor(props) {
    super(props);
    this.state = { loaded: false, unread: false, mine: null, guardian: null, gateway: null, liquidity: null, was: {}, now: {}, step: 'idle', plan: null, message: null, ...(props.initial || {}) };
    this.undo = this.undo.bind(this); this.review = this.review.bind(this); this.confirm = this.confirm.bind(this); this.retry = this.retry.bind(this);
  }
  async componentDidMount() {
    if (this.state.loaded || !this.props.api) return;
    await this.load();
  }
  retry() { this.setState({ loaded: false, unread: false }); return this.load(); }
  async load() {
    const get = async (p) => { try { return await this.props.api.get(p); } catch { return null; } };
    // THE ROLES READ AGAIN BEFORE ANYTHING IS SAID (2026-10-22, guardian-6's owner page during a seat restart: every role "Off" and
    // "not in the census yet" for a node in the census, serving three roles): an unanswered /roles is no census row - asked up to three
    // times, then said as unread, with Try again
    const pause = this.props.pause || ((ms) => new Promise((ok) => setTimeout(ok, ms)));
    let pub = null;
    for (let i = 0; i < 3 && !pub; i++) { if (i) await pause(2000); pub = await get('/roles'); }
    if (!pub) { this.setState({ loaded: true, unread: true }); return; }
    const [guardian, gateway, liquidity] = await Promise.all([get('/guardian'), get('/gateway-claim'), get('/liquidity-claim')]);
    const mine = pub && (pub.nodes || []).find((x) => x.node === this.props.node) || null;
    const was = switchesOf(mine);
    // A GATEWAY THAT RUNS BUT HOLDS NO SEAT YET (kanban #563, measured on installer C 2026-10-21: its tile said "Off" and "Set up" while its
    // gatewayd waited for its federation): the node's own services say whether the gateway runs; its seat claim comes only after the peg-in
    let gatewayRuns = false;
    if (!(gateway && gateway.gatewayUrl) && this.props.api.post && this.props.api.signed) {
      try { const sv = await this.props.api.post('/owner/services', await this.props.api.signed('services')); gatewayRuns = !!(sv && sv.ok && (sv.services || []).some((x) => x.id === 'gateway' && x.running)); } catch { gatewayRuns = false; }
    }
    // WHAT THE GATEWAY WAITS FOR (2026-10-26, the owner on "Waiting - The routing fees of its federation": "What is it waiting for??" -
    // "Clarify what it is waiting for"): the founding with its count, then the peg-in with its confirmations (GET /setup-status)
    const setup = gatewayRuns ? await get('/setup-status') : null;
    this.setState({ loaded: true, unread: false, mine, guardian, gateway, gatewayRuns, liquidity, setup, was, now: { ...was } });
  }
  toggle(k, on) { this.setState((s) => ({ now: { ...s.now, [k]: on }, step: 'idle', plan: null, message: null })); }
  undo() { this.setState((s) => ({ now: { ...s.was }, step: 'idle', plan: null, message: null })); }
  async review() {
    this.setState({ step: 'checking', message: 'Checking…' });
    try {
      const p = await this.props.api.post('/owner/roles', await this.props.api.signed('roles', { ...askOf(this.state.now), post: false }));
      if (!p || !p.ok) return this.setState({ step: 'idle', message: (p && p.why) || 'not possible' });
      this.setState({ step: 'review', plan: p.plan, message: null });
    } catch (e) { this.setState({ step: 'idle', message: e.message }); }
  }
  async confirm() {
    this.setState({ step: 'sending' });
    try {
      const d = await this.props.api.post('/owner/roles', await this.props.api.signed('roles', { ...askOf(this.state.now), post: true }));
      if (!d || !d.ok) return this.setState({ step: 'review', message: (d && d.why) || 'not sent' });
      this.setState({ step: 'sent', txid: d.update && d.update.txid, message: null });
    } catch (e) { this.setState({ step: 'review', message: e.message }); }
  }
  tiles() {
    const { mine, guardian, gateway, liquidity, gatewayRuns, setup } = this.state;
    const guarding = !!(guardian && guardian.guardian);
    const gatewayWaits = !(gateway && gateway.gatewayUrl) && !!gatewayRuns;
    return [
      ['play', '🎮', 'Play and check rounds', 'A share of every round\'s node fee', 'Replays the rounds it is drawn for and signs who won.'],
      // THE AUDIT ROLE (spec §13A.1, kanban #725): drawn in secret, outside the round's seats
      ['audit', '🔎', 'Audit rounds', '10 % of the node fee of the rounds it checks', 'Drawn in secret for rounds it is not seated in: replays them and objects if a result was signed wrong.'],
      ['settlement', '💸', 'Pay out winners', 'A share of every round\'s node fee', 'Co-signs the payout once a result is signed.'],
      ['relay', '📡', 'Relay for other nodes', 'Keeps rounds reachable', 'Every node does this: it serves round data to players and other nodes. Always on.', 'On', true],
      ['custody', '🛡️', 'Guardian (custody)', 'The guardians\' share of every round', guarding ? 'Guards players\' bitcoin in a federation with other guardians.' : 'Ready to be drawn as a guardian when a federation is founded.', guarding ? 'Guarding' : null],
      ['gateway', '⚡', 'Lightning gateway', 'The routing fees of its federation', gatewayWaits ? gatewayWaitsFor(setup) : 'Takes deposits and pays winners over Lightning. Up to 2 per federation.', gatewayWaits ? 'Waiting' : null, !!(gateway && gateway.gatewayUrl) || gatewayWaits, 'services:svc-gateway'],
      ['liquidity', '💧', 'Liquidity provider', 'A share of the 1 % liquidity pool', 'Opens incoming Lightning channels to new nodes.', null, !!liquidity, 'roles:liquidity'],
    ].map(([k, icon, name, highlight, does, label, onOther, section]) => ({ k, icon, name, highlight, does, label, onOther, section, mine }));
  }
  render() {
    const { loaded, unread, mine, was, now, step, plan, message } = this.state;
    if (!loaded) return <p className="sub">reading this node's roles…</p>;
    if (unread) return <div><p className="warn">Couldn't load the roles. The node may be restarting.</p><Button primary onClick={this.retry}>Try again</Button></div>;
    const changed = changedOf(was, now);
    const sent = step === 'sent';
    return (
      <div>
        <div className="tiles">
          {this.tiles().map((t) => {
            const switchable = SWITCHABLE.includes(t.k);
            const on = switchable ? !!was[t.k] : t.onOther;
            const state = changed.includes(t.k) ? 'changed' : on ? 'on' : null;
            const footer = switchable
              ? (mine ? [<span key="s" />, <Switch key="w" id={`rl-${t.k}`} label={t.name} checked={!!now[t.k]} disabled={sent} onChange={(v) => this.toggle(t.k, v)} />]
                : <span className="sub">Changeable once the bond counts</span>)
              : <a className="go" href={`#${String(t.section).split(':')[0]}`} onClick={goTo(t.section)}>{on ? 'Manage' : 'Set up'} →</a>;
            return <Tile key={t.k} id={`tile-${t.k}`} icon={t.icon} name={t.name} highlight={t.highlight} does={t.does} state={state}
              pill={sent && changed.includes(t.k) ? 'Saving…' : t.label || (on ? 'On' : 'Off')} pillTone={(sent && changed.includes(t.k)) || t.label === 'Waiting' ? 'wait' : on ? 'on' : null} footer={footer} />;
          })}
        </div>
        <SaveBar open={changed.length > 0} label={`${changed.length} change${changed.length === 1 ? '' : 's'} not saved`}
          message={sent ? <p className="ok"><b>Sent ✓</b> the new roles count after 6 blocks.</p>
            : step === 'review' && plan ? <p>Fee <b>{Number(plan.feeSats).toLocaleString('en-US')} sat</b> from your bond wallet · counts after 6 blocks (about 1 hour).</p>
              : message ? <p className="warn">{message}</p> : null}>
          {sent ? null : step === 'review'
            ? [<Button key="u" onClick={this.undo}>Undo</Button>, <Button key="c" primary onClick={this.confirm}>Confirm</Button>]
            : [<Button key="u" onClick={this.undo}>Undo</Button>, <Button key="r" primary disabled={step === 'checking'} onClick={this.review}>Review changes</Button>]}
        </SaveBar>
        {mine ? null : <p className="sub">Your node isn't in the census yet. You can change roles once its bond counts.</p>}
      </div>
    );
  }
}
