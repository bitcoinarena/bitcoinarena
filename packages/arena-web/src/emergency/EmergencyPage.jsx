// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// "MY NODE IS OFFLINE" IN REACT (kanban #564; spec §23A.5a, protocol 17): /Dashboard/emergency on every node, no login. The owner types
// the emergency code written down at install; the browser makes the emergency key from it (the node's own /owner/client.js, handed in as
// `client`), finds the node whose bond advertisement names that key (GET /emergency-departures?key=), and signs a leave request at this
// node's tip (POST /emergency-departure). Only the request and its signature leave the browser. A class component in three steps:
// the code, the node found, the node out.
import React from 'react';

/** What leaving does, by the node's role - the page's table. */
export const OUTCOMES = Object.freeze([
  ['No guardian role', 'At once, from every seating', 'Yours', 'ok'],
  ['A guardian, in time', 'At once; its federation\'s succession starts now', 'Yours', 'ok'],
  ['A guardian, too late (offline longer than the network allows: ~48 h on mainnet, 12 blocks on testnet4)', 'Nothing changes: it is abandonment', 'Slashed', 'bad'],
]);

export class EmergencyPage extends React.Component {
  constructor(props) {
    super(props);
    this.state = { code: '', error: null, busy: false, found: null, sent: null, ...(props.initial || {}) };
    this.secret = null;
    this.find = this.find.bind(this); this.leave = this.leave.bind(this);
  }
  async find(e) {
    if (e && e.preventDefault) e.preventDefault();
    const C = this.props.client;
    this.setState({ error: null, found: null });
    let bytes; try { bytes = C.parseEmergencyCode(this.state.code); } catch (x) { return this.setState({ error: x.message }); }
    this.secret = C.emergencySecret(bytes);
    const key = C.toHex(C.pubkeyOf(this.secret));
    this.setState({ busy: true });
    let r; try { r = await this.props.get(`/emergency-departures?key=${key}`); } catch (x) { return this.setState({ busy: false, error: `this node did not answer: ${x.message}` }); }
    if (!r || !r.named) return this.setState({ busy: false, error: 'No node of the census names this emergency code in its bond advertisement. Check the code - or your node\'s bond was posted before protocol 17 and has no emergency path.' });
    this.setState({ busy: false, found: { ...r.named, tip: r.tip, key } });
  }
  async leave() {
    const C = this.props.client, f = this.state.found;
    this.setState({ busy: true, error: null });
    try {
      const d = C.signEmergencyDeparture({ nodePubkey: C.fromHex(f.node), emergencyPubkey: C.fromHex(f.key), postedAt: Number(f.tip) }, (m) => C.sign(m, this.secret));
      const j = await this.props.post('/emergency-departure', C.toHex(C.encodeEmergencyDeparture(d)) + C.toHex(d.signature));
      this.secret = null;
      this.setState({ busy: false, sent: j });
    } catch (x) { this.setState({ busy: false, error: x.message }); }
  }
  step() {
    const { code, error, busy, found: f, sent } = this.state;
    if (sent) return (
      <div className="card done">
        <div className="big ok">✓</div>
        <h3>Your node is out</h3>
        <p>The leave request (block {sent.postedAt}) is held here and passed on to every seat. {f.guardianOf.length ? 'Its federation\'s succession starts now; its bond stays yours if it was in time.' : 'It is in no seating from now on; its bond stays yours.'}</p>
      </div>);
    if (f) return (
      <div className="card">
        <div className="steps"><span className="done">1 Code</span><span className="now">2 Confirm</span><span>3 Out</span></div>
        <h3>Your node</h3>
        <div className="kv">
          <div className="row"><span>Node key</span><b><code>{f.node.slice(0, 16)}…</code></b></div>
          <div className="row"><span>Address</span><b>{f.endpoint || '-'}</b></div>
          <div className="row"><span>Roles</span><b>{f.roles.join(', ') || '-'}</b></div>
          <div className="row"><span>Guardian of</span><b>{f.guardianOf.length ? f.guardianOf.map((x) => x.slice(0, 8)).join(', ') : 'no federation'}</b></div>
          <div className="row"><span>Signed at block</span><b>{f.tip}</b></div>
        </div>
        {f.held ? <p className="ok">This node already holds a leave request for it.</p> : null}
        <div className="warn">Taking it out cannot be undone: the node serves again only with a new advertisement.</div>
        <div className="actions">
          <button type="button" disabled={busy} onClick={() => { this.secret = null; this.setState({ found: null, code: '' }); }}>Back</button>
          <button type="button" className="primary danger" disabled={busy} onClick={this.leave}>Yes, leave the network</button>
        </div>
        <p className="err">{error}</p>
      </div>);
    return (
      <form className="card" onSubmit={this.find}>
        <div className="steps"><span className="now">1 Code</span><span>2 Confirm</span><span>3 Out</span></div>
        <label htmlFor="code">Emergency code</label>
        <input id="code" value={code} onChange={(e) => this.setState({ code: e.target.value })} placeholder="ARN-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" autoComplete="off" spellCheck="false" autoCapitalize="characters" />
        <p className="hint">Never type your 24 words here - this page does not want them.</p>
        <button type="submit" className="primary" disabled={busy || !code.trim()}>{busy ? 'Looking for your node…' : 'Find my node'}</button>
        <p className="err">{error}</p>
      </form>);
  }
  render() {
    return (
      <div className="emergency">
        <h1>My node is offline</h1>
        <p className="sub">Take your own node out of the network while it is offline, so it keeps its bond. You need the emergency code you wrote down when you installed it (<code>ARN-…</code>).</p>
        {this.step()}
        <div className="card">
          <h3>What it does</h3>
          <div className="outcomes">{OUTCOMES.map(([who, out, bond, tone]) => (
            <div key={who} className="outcome"><span>{who}</span><b>{out}</b><i className={tone}>Bond: {bond}</i></div>))}</div>
          <p className="sub">Coming back afterwards needs a new advertisement from the node. The code can do nothing else: no money, no settings.</p>
        </div>
        <p className="sub"><a href={this.props.dashboardHref || '../Dashboard'}>← This node's dashboard</a></p>
      </div>);
  }
}
