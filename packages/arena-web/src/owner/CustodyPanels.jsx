// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER DASHBOARD'S CUSTODY AND LIQUIDITY, IN REACT (kanban #564). Custody: whether this node is a guardian (GET /guardian) and where
// its guardian is reached, else how to add custody. Liquidity: what a provider holds free for new channels against the deposit minimum
// (free + the channels it gave, 2026-10-18), the channels it gave, its top-up address and a new one (POST /owner/liquidity/new-address).
import React from 'react';
import { Button } from '../design/components.jsx';

/** The liquidity deposit minimum (sat): free coins + the channels given. */
export const LIQUIDITY_DEPOSIT = Object.freeze({ testnet4: 500000, mainnet: 2500000 });
const n = (x) => Number(x).toLocaleString('en-US');

export class CustodyPanel extends React.Component {
  constructor(props) { super(props); this.state = { loaded: false, guardian: null, ...(props.initial || {}) }; }
  async componentDidMount() {
    if (this.state.loaded || !this.props.api) return;
    let g = null; try { g = await this.props.api.get('/guardian'); } catch { g = null; }
    this.setState({ loaded: true, guardian: g });
  }
  render() {
    const { loaded, guardian: g } = this.state;
    if (!loaded) return <p className="sub">reading whether this node holds custody…</p>;
    if (g && g.guardian) return (
      <div><div className="row"><span>Custody</span><b>on - this node is a guardian</b></div>
        <div className="row"><span>Guardian endpoint</span><b><code>{g.endpoint || ''}</code></b></div></div>);
    return (
      <div>
        <p><b>This node holds no custody.</b> A custody node is one of a federation's 10 guardians, may run one of its 2 Lightning gateways, and earns a share of every round of its federation (the guardians' third of the 4 % node fee).</p>
        <p>To add it, on the machine the node runs on open <b>Add custody</b> (Start menu &gt; Arena Node, or the Arena Node scripts) or run <code>arena-install --add-custody</code>. The installer shows the custody screens - what custody is, Lightning and the gateway, the federation, the bond's rules - and updates your bond; no second bond.</p>
        <p className="sub">Custody needs your own Bitcoin Core (not Electrum) and Lightning (LND, set up there).</p>
      </div>);
  }
}

/** What a provider holds against the minimum, and how much it is short. */
export function standingOf(claim, network = 'testnet4') {
  const min = LIQUIDITY_DEPOSIT[network] || LIQUIDITY_DEPOSIT.testnet4;
  const free = Number(claim.freeSats || 0), given = claim.channels || [];
  const givenSats = given.reduce((a, x) => a + Number(x.capacitySats), 0);
  const held = free + givenSats;
  return { min, free, given, givenSats, held, short: Math.max(0, min - held) };
}

export class LiquidityPanel extends React.Component {
  constructor(props) { super(props); this.state = { loaded: false, claim: null, busy: false, message: null, ...(props.initial || {}) }; this.newAddress = this.newAddress.bind(this); }
  componentDidMount() { if (!this.state.loaded && this.props.api) this.read(); }
  async read() {
    let c = null; try { c = await this.props.api.get('/liquidity-claim'); } catch { c = null; }
    this.setState({ loaded: true, claim: c });
  }
  async newAddress() {
    this.setState({ busy: true, message: 'Asking LND for a new address…' });
    let r; try { r = await this.props.api.post('/owner/liquidity/new-address', await this.props.api.signed('liquidity/new-address')); } catch (x) { r = { ok: false, why: x.message }; }
    if (!r || !r.ok) return this.setState({ busy: false, message: (r && r.why) || 'no new address' });
    await this.read();
    this.setState({ busy: false, message: `New address: ${r.address}` });
  }
  render() {
    const { loaded, claim: c, busy, message } = this.state;
    if (!loaded) return <p className="sub">reading whether this node is a liquidity provider…</p>;
    if (!c) return <p><b>This node is no liquidity provider.</b> A provider opens incoming Lightning channels to new nodes and earns a share of the 1 % liquidity pool of their federations. To become one, run <code>arena-install</code> again and choose <b>Liquidity provider</b>.</p>;
    const st = standingOf(c);
    return (
      <div>
        <div className="row"><span>Free for new channels</span><b>{n(st.free)} sat</b></div>
        <div className="row"><span>Deposit minimum (free + channels given)</span><b>{n(st.min)} sat</b></div>
        {st.short ? <p className="err"><b>Below the deposit minimum: this provider earns no share of the liquidity pool</b> until it is topped up by {n(st.short)} sat.</p>
          : <p className="ok">Above the deposit minimum: it earns its share of the liquidity pool.</p>}
        <div className="row"><span>Channels given to new nodes</span><b>{st.given.length} ({n(st.givenSats)} sat)</b></div>
        {st.given.map((x) => <div key={x.peer} className="row"><span><code>{x.peer.slice(0, 16)}…</code></span><b>{n(x.capacitySats)} sat</b></div>)}
        <div className="row"><span>Top up (LND's wallet, testnet4)</span><b><code>{c.depositAddress || '(not known yet)'}</code></b></div>
        <p><Button disabled={busy} onClick={this.newAddress}>New address</Button> <span className="sub">{message}</span></p>
      </div>);
  }
}
