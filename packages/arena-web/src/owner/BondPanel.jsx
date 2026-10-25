// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER DASHBOARD'S BOND, IN REACT (kanban #564): the bitcoin this node locked so it can be drawn - how much (in parts when it was
// added to), the lock and when it ends, the bond wallet, its outputs on the chain - and the withdrawal once the lock is over (POST
// /owner/bond-withdraw, signed; the node leaves the network). Read from GET /owner/bond.
import React from 'react';
import { Button } from '../design/components.jsx';
import { SetupStatus } from '../dashboard/SetupStatus.jsx';

const n = (x) => Number(x).toLocaleString('en-US');
/** "3 d 4 h" / "5 h 20 min" for a span in ms. */
export function daysHours(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), min = m % 60;
  return d ? `${d} d ${h} h` : h ? `${h} h ${min} min` : `${min} min`;
}
export function lockText(l, nowMs = Date.now()) {
  if (!l) return '';
  return l.withdrawable ? 'unlocked' : `locked · ${n(l.blocksLeft)} blocks (about ${daysHours(l.estimatedMs - nowMs)})`;
}

export class BondPanel extends React.Component {
  constructor(props) {
    super(props);
    this.state = { loaded: false, bond: null, setup: null, address: '', busy: false, message: null, ...(props.initial || {}) };
    this.withdraw = this.withdraw.bind(this);
  }
  async componentDidMount() {
    if (this.state.loaded || !this.props.api) return;
    let b = null; try { b = await this.props.api.get('/owner/bond'); } catch { b = null; }
    // the setup's progress (kanban #635): the bond's and the peg-in's confirmations, Bitcoin Core's background sync
    let setup = null; try { setup = await this.props.api.get('/setup-status'); } catch { setup = null; }
    this.setState({ loaded: true, bond: b, setup });
  }
  async withdraw() {
    const address = this.state.address.trim();
    if (!address) return this.setState({ message: 'Type the address the bond goes to.' });
    const ask = this.props.confirm || ((q) => window.confirm(q));
    if (!ask(`Withdraw the whole bond to ${address}? This node leaves the network.`)) return;
    this.setState({ busy: true, message: null });
    try {
      const r = await this.props.api.post('/owner/bond-withdraw', await this.props.api.signed('bond-withdraw', { address, feeRate: 2 }));
      if (!r || r.ok === false) return this.setState({ busy: false, message: (r && r.why) || 'not sent' });
      this.setState({ message: `Sent: ${r.txid} (${n(r.value)} sat)` });
    } catch (e) { this.setState({ busy: false, message: e.message }); }
  }
  render() {
    const { loaded, bond: b, address, busy, message } = this.state;
    if (!loaded) return <p className="sub">Loading the bond…</p>;
    if (!b) return <p className="sub">Couldn't load the bond.</p>;
    const setup = <SetupStatus status={this.state.setup} />;
    if (!b.bond) return <div>{setup}<p>No bond yet. Until it has one, this node is not drawn for rounds.</p>{this.oldBonds()}</div>;
    const l = b.lock;
    const outs = Array.isArray(b.outputs) && b.outputs.length > 1 ? b.outputs : null;
    const nowMs = this.props.nowMs ? this.props.nowMs() : Date.now();
    const open = !!(l && l.withdrawable);
    return (
      <div>
        {setup}
        {/* THE BOND AT A GLANCE (kanban #565): the amount, the lock, the wallet - one stat card each, as the overview */}
        <div className="stats">
          <div className="stat"><span>Bond</span><b>{n(b.total || b.bond.sats)} sat</b><small>{outs ? `in ${outs.length} parts on the chain` : 'one output on the chain'}</small></div>
          <div className="stat"><span>Lock</span><b className={open ? 'ok' : undefined}>{open ? 'Unlocked' : 'Locked'}</b>
            <small>{l ? (open ? 'it can be withdrawn now' : `${n(l.blocksLeft)} blocks left · about ${daysHours(l.estimatedMs - nowMs)}`) : 'not read'}</small></div>
          {b.wallet && !b.wallet.why ? <div className="stat"><span>Bond wallet</span><b>{n(b.wallet.spendableSats)} sat</b><small>spendable, for adding to the bond</small></div> : null}
        </div>
        <h3 className="sh">On the chain</h3>
        <div className="scroll"><table className="tbl"><thead><tr><th>Output</th><th className="n">Amount</th></tr></thead>
          <tbody>{(outs || [b.bond]).map((o) => <tr key={`${o.txid}:${o.vout}`}><td><code>{o.txid.slice(0, 16)}…:{o.vout}</code></td><td className="n">{n(o.sats)} sat</td></tr>)}</tbody></table></div>
        <h3 className="sh">Withdraw</h3>
        <div className={`withdraw${open ? '' : ' off'}`}>
          <p className="sub">{open ? 'The whole bond goes to the address you type. The node then leaves the network.' : 'Possible once the lock is over. The node then leaves the network.'}</p>
          <div className="inline">
            <input placeholder={`your ${b.network || 'testnet4'} address`} value={address} disabled={!open} onChange={(e) => this.setState({ address: e.target.value })} />
            <Button disabled={busy || !open} onClick={this.withdraw}>Withdraw</Button>
          </div>
          {message ? <p className="sub">{message}</p> : null}
        </div>
        {this.oldBonds()}
      </div>
    );
  }
  // OLD BONDS AFTER A KEY SWITCH (kanban #650): each with its lock; at maturity taken back with the old key to an address the owner names
  oldBonds() {
    const olds = (this.state.bond && this.state.bond.oldBonds) || [];
    if (!olds.length) return null;
    const s = this.state;
    return (
      <div className="old-bonds" id="old-bonds">
        <h3 className="sh">Old bonds</h3>
        <p className="sub">Left under your node's old key when it moved to the key from your 24 words.</p>
        {olds.map((o) => {
          const k = `${o.txid}:${o.vout}`, open = !!(o.lock && o.lock.withdrawable);
          return (
            <div className="withdraw" key={k}>
              <p><b>{n(o.sats)} sat</b> · {open ? 'unlocked' : o.lock ? `locked for ${n(o.lock.blocksLeft)} more blocks (until block ${n(o.maturity)})` : `locked until block ${n(o.maturity)}`}{o.held ? '' : ' · this node no longer holds its key'}</p>
              {open && o.held ? <div className="inline">
                <input placeholder="your testnet4 address" value={(s.oldTo || {})[k] || ''} onChange={(e) => this.setState({ oldTo: { ...(s.oldTo || {}), [k]: e.target.value } })} />
                <Button disabled={s.busy} onClick={() => this.takeBack(o)}>Take it back</Button>
              </div> : null}
              {(s.oldSaid || {})[k] ? <p className="sub">{s.oldSaid[k]}</p> : null}
            </div>);
        })}
      </div>);
  }
  async takeBack(o) {
    const k = `${o.txid}:${o.vout}`, address = String((this.state.oldTo || {})[k] || '').trim();
    const say = (t) => this.setState((st) => ({ busy: false, oldSaid: { ...(st.oldSaid || {}), [k]: t } }));
    if (!address) return say('Type the address it goes to.');
    const ask = this.props.confirm || ((q) => window.confirm(q));
    if (!ask(`Send the old bond of ${n(o.sats)} sat to ${address}?`)) return;
    this.setState({ busy: true });
    try {
      const r = await this.props.api.post('/owner/old-bond-withdraw', await this.props.api.signed('old-bond-withdraw', { txid: o.txid, vout: o.vout, address, feeRate: 2 }));
      if (!r || r.ok === false) return say((r && r.why) || 'not sent');
      say(`Sent: ${r.txid} (${n(r.value)} sat)`);
    } catch (e) { say(e.message); }
  }
}
