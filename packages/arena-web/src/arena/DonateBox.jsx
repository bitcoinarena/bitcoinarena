// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE DONATE BOX IN REACT (kanban #564, the Arena page's footer Donate and a game's own): what ARENA_DONATE_OPEN drew by hand into
// #arena-donate - to whom, the shares of their donation set, the amounts (ARENACLIENT.GIFT_CHOICES_SAT) and Custom, the wallet's balance,
// Donate then "Confirm: give N sat" (a second tap sends), and what happened. The same lines while the set and the balance are read (kanban
// #551: the box keeps its size). The page keeps the rules and hands them over: `who`, `choices`, `amountOf(text)` (giftAmountOf), `read()`
// (the shares line, whether the set was read, the most one federation of the wallet holds - null with no wallet), `give(sat)` (the gift:
// the key, the federation that holds it, giftDonation), `onClose`. A class component; the class names are the page's.
import React from 'react';

const n = (sat) => Number(sat).toLocaleString('en-US');

export class DonateBox extends React.Component {
  constructor(props) {
    super(props);
    this.gone = false;
    this.state = { chosen: null, typed: '', confirming: false, busy: false, said: '', bad: false, read: null };
  }
  componentWillUnmount() { this.gone = true; }
  set(u) { if (!this.gone) this.setState(u); }
  async componentDidMount() { await this.reread(); }
  async reread() { const read = await this.props.read(); this.set({ read }); }
  best() { const r = this.state.read; return r && r.bestSat !== null ? BigInt(r.bestSat) : 0n; }
  // a choice: Donate says its amount, and the box says when one federation of the wallet holds less
  pick(sat, typed = '') { this.setState({ chosen: sat, typed, confirming: false, said: '', bad: false }); }
  typed(text) {
    if (!text.trim()) return this.pick(null, text);
    const a = this.props.amountOf(text);
    if (!a.ok) return this.setState({ chosen: null, typed: text, confirming: false, said: a.why, bad: true });
    this.pick(a.sat, text);
  }
  async go() {
    const { chosen, confirming, read } = this.state;
    if (chosen === null || !read || !read.setOk) return;
    if (!confirming) return this.setState({ confirming: true, said: `Tap again to send ${n(chosen)} sat to ${this.props.who}.`, bad: false });
    this.setState({ busy: true, said: `Paying ${n(chosen)} sat …`, bad: false });
    const got = await this.props.give(chosen);
    if (got.ok) {
      this.set({ busy: false, confirming: false, chosen: null, typed: '', said: `Thank you! ${n(chosen)} sat sent · transaction ${String(got.txid).slice(0, 12)}…`, bad: false });
      await this.reread();
    } else this.set({ busy: false, confirming: false, said: got.tell || `Not sent (${got.step}): ${got.why}`, bad: true });
  }
  render() {
    const { who, choices, onClose } = this.props;
    const { chosen, typed, confirming, busy, read } = this.state;
    const over = chosen !== null && read && BigInt(chosen) > this.best();
    const said = over ? `Your wallet holds ${n(this.best())} sat in one federation: that is the most you can give.` : this.state.said;
    const bad = over || this.state.bad;
    return (
      <div className="box">
        <div className="top"><h3>Donate to the developers</h3><button type="button" className="x" aria-label="Close" onClick={onClose}>{'×'}</button></div>
        <p className="to">{`To ${who}, in e-cash from your wallet.`}</p>
        {/* only a set that cannot be read is said here - no shares (kanban #672: they show in the owner area's Donations alone) */}
        <p className="split muted">{read ? read.sharesLine : ''}</p>
        <div className="amounts" role="group" aria-label="amount">
          {choices.map((sat) => <button key={sat} type="button" data-sat={String(sat)} aria-pressed={String(chosen === sat && !typed)} onClick={() => this.pick(sat)}>{n(sat) + ' sat'}</button>)}
        </div>
        <label className="custom">Custom <input inputMode="numeric" placeholder="sat" autoComplete="off" value={typed} onChange={(e) => this.typed(e.target.value)} /></label>
        <p className="bal muted">{!read ? 'Your wallet: … sat (checking)' : read.bestSat === null ? 'Open your wallet and deposit first.' : `Your wallet: ${n(read.bestSat)} sat`}</p>
        <div className="row"><button type="button" className="go primary" disabled={busy || chosen === null || over || !read || !read.setOk} onClick={() => this.go()}>
          {chosen === null ? 'Donate' : confirming ? `Confirm: give ${n(chosen)} sat` : `Donate ${n(chosen)} sat`}</button></div>
        <p className={'say' + (bad ? ' bad' : '')} role="status">{said}</p>
      </div>);
  }
}
