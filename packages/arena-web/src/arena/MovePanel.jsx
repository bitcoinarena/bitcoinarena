// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE MOVE WINDOW (kanban #598, the owner 2026-10-23: "da soll ein Fenster aufgehen: Move from Federation X to Federation Y mit einem amount,
// standardmässig alles von der Federation"): From - the federations that hold this wallet's funds, the fullest first -, To - every other
// federation that takes deposits -, and the amount, filled with all that From can send after the fees as soon as it is read. The page keeps
// its rules and hands them over: `feds` ([{ id, label, sats, from, to }]), `canOf(id)` (the exact msat From can send), `move({ from, to,
// amountMsat (null: all), onStep })` (ARENACLIENT.movePlayerWallet), `onMoved` (history and balance read again).
import React from 'react';

const satOf = (msat) => `${(BigInt(msat) / 1000n).toLocaleString('en-US')} sat`;
const short = (id) => String(id || '').slice(0, 8);

export class MovePanel extends React.Component {
  constructor(props) {
    super(props);
    const from = (props.feds || []).filter((f) => f.from).sort((a, b) => b.sats - a.sats)[0];
    this.gone = false;
    this.state = { from: from ? from.id : '', to: '', can: null, amount: '', edited: false, status: null, busy: false };
    this.state.to = this.targets(this.state.from)[0] ? this.targets(this.state.from)[0].id : '';
  }
  set(u) { if (!this.gone) this.setState(u); }
  componentDidMount() { if (this.state.from) this.read(this.state.from); }
  componentWillUnmount() { this.gone = true; }
  targets(from) { return (this.props.feds || []).filter((f) => f.to && f.id !== from); }
  async read(from) {
    this.set({ can: null, amount: '', edited: false });
    try {
      const can = await this.props.canOf(from);
      if (this.state.from !== from) return;
      this.set({ can, amount: can > 0n ? String(can / 1000n) : '' });
    } catch (e) { this.set({ can: 0n, status: { words: `What federation ${short(from)} can send could not be read: ${e && e.message ? e.message : e}`, kind: 'bad' } }); }
  }
  pickFrom(id) {
    const to = this.state.to && this.state.to !== id ? this.state.to : ((this.targets(id)[0] || {}).id || '');
    this.set({ from: id, to, status: null });
    this.read(id);
  }
  async go() {
    const { from, to, can, amount, edited } = this.state;
    if (!from || !to) { this.set({ status: { words: 'Choose a federation to move from and one to move to.', kind: 'bad' } }); return; }
    const sat = Number(String(amount).replace(/[^0-9]/g, ''));
    if (!(sat > 0)) { this.set({ status: { words: 'A move is more than 0 sat.', kind: 'bad' } }); return; }
    // ALL OF IT, EXACTLY (not rounded down to whole sat) while the amount is the one filled in
    const all = can !== null && !edited && BigInt(sat) === can / 1000n;
    const amountMsat = all ? null : BigInt(sat) * 1000n;
    if (can !== null && amountMsat !== null && amountMsat > can) { this.set({ status: { words: `Federation ${short(from)} can send ${satOf(can)} after the fees. Choose a smaller amount.`, kind: 'bad' } }); return; }
    this.set({ busy: true, status: { words: 'Opening both wallets …', kind: 'busy' } });
    let r;
    try {
      r = await this.props.move({ from, to, amountMsat, onStep: (m) => this.set({ status: { words: m.state === 'swapping' ? `Moving ${satOf(m.amountMsat)} over Lightning …` : String(m.state), kind: 'busy' } }) });
    } catch (e) { r = { ok: false, why: e && e.message ? e.message : String(e) }; }
    if (r && r.ok) {
      this.set({ busy: false, status: { words: `Moved ${satOf(r.movedMsat)} from federation ${short(from)} to federation ${short(to)}${r.feeMsat ? ` (fee ${satOf(r.feeMsat)})` : ''}.`, kind: 'ok' } });
      if (this.props.onMoved) this.props.onMoved(r);
      this.read(from);
    } else this.set({ busy: false, status: { words: `Nothing was moved: ${(r && r.why) || 'the move stopped'}`, kind: 'bad' } });
  }
  render() {
    const { feds } = this.props;
    const { from, to, can, amount, status, busy } = this.state;
    const froms = (feds || []).filter((f) => f.from).sort((a, b) => b.sats - a.sats), tos = this.targets(from);
    if (!froms.length) return <div className="mv-panel"><div className="muted">No federation holds funds of this wallet yet, so there is nothing to move.</div></div>;
    return (
      <div className="mv-panel">
        <label className="mv-row">From
          <select id="arena-mv-from" value={from} disabled={busy} onChange={(e) => this.pickFrom(e.target.value)}>
            {froms.map((f) => <option key={f.id} value={f.id}>{f.label} · {f.sats.toLocaleString('en-US')} sat</option>)}</select></label>
        <label className="mv-row">To
          <select id="arena-mv-to" value={to} disabled={busy || !tos.length} onChange={(e) => this.set({ to: e.target.value, status: null })}>
            {tos.length ? tos.map((f) => <option key={f.id} value={f.id}>{f.label}</option>) : <option value="">no other federation takes deposits</option>}</select></label>
        <label className="mv-row">Amount (sat)
          <span className="mv-amt"><input id="arena-mv-amount" inputMode="numeric" value={amount} disabled={busy} placeholder={can === null ? 'reading …' : '0'}
            onChange={(e) => this.set({ amount: e.target.value.replace(/[^0-9]/g, ''), edited: true })} />
            <button type="button" className="mv-all" disabled={busy || !can} onClick={() => this.set({ amount: String(can / 1000n), edited: false })}>All</button></span></label>
        <div className="muted" id="arena-mv-can">{can === null ? 'Reading what it can send …' : can > 0n ? `All it can send after the fees: ${satOf(can)}.` : 'Nothing to send from this federation after the fees.'}</div>
        <button type="button" id="arena-mv-go" disabled={busy || !to || !can} onClick={() => this.go()}>{busy ? 'Moving …' : `Move ${amount ? Number(amount).toLocaleString('en-US') + ' sat' : ''}`}</button>
        {status ? <div className={`mv-status ${status.kind}`} id="arena-mv-status">{status.words}</div> : null}
      </div>);
  }
}
