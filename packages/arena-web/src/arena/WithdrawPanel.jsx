// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE WITHDRAW PANEL IN REACT (kanban #564, the Arena page): what the page's openWithdraw drew into #arena-withdraw-panel by hand - the
// invoice defines the amount (2026-10-01, "1 and 3"): the panel says how much can be withdrawn, the player pastes an invoice from their own
// wallet for up to that, the amount is read off it, and one over the balance is refused in the player's words before the wallet spends.
// The balance the page already read is said and usable at once (kanban #539), the exact amount after fees replaces it when it comes. The
// page keeps its rules and hands them over: `knownSat` (that federation's balance, or null), `readExact()` (the exact msat), `invoiceAmount`
// (ARENACLIENT.invoiceAmountMsat), `send({ amountMsat, invoice, onStep })` (the wallet's withdraw), `say` (the money why-line, the page's),
// `onSent` (history and balance read again). A class component; the ids are the page's, so its stylesheet and probes read it as before.
import React from 'react';

const TOO_MUCH = 'Not enough to withdraw that amount after fees. Choose a smaller amount.';
const satOf = (msat) => `${(BigInt(msat) / 1000n).toLocaleString('en-US')} sat`;
const hostOf = (u) => { try { return new URL(u).host; } catch { return String(u || ''); } };

export class WithdrawPanel extends React.Component {
  constructor(props) {
    super(props);
    const k = props.knownSat;
    this.canMsat = null; this.gone = false;
    this.state = { usable: k > 0, invoice: '', chosen: null, chosenText: '', status: null,
      amount: k > 0
        ? `You have ${k.toLocaleString('en-US')} sat. Make an invoice in your own wallet for a little less (the Lightning fee comes off) and paste it here - the exact most is being read.`
        : 'You can withdraw up to … sat (checking). Make an invoice in your own wallet for any amount up to that and paste it here.' };
  }
  set(u) { if (!this.gone) this.setState(u); }
  status(step, words, kind = '') { this.set({ status: { step, words, kind } }); }
  componentWillUnmount() { this.gone = true; }
  async componentDidMount() {
    try {
      const can = await this.props.readExact();
      this.canMsat = can;
      this.set({ usable: can > 0n, amount: can > 0n ? `You can withdraw up to ${satOf(can)}. Make an invoice in your own wallet for any amount up to that and paste it here.`
        : 'Your wallet is empty, so there is nothing to withdraw.' });
      if (can > 0n && this.state.invoice) this.read(this.state.invoice);   // an invoice pasted meanwhile is checked against the exact amount
    } catch (e) { this.set({ amount: 'Your balance could not be read (' + (e && e.message ? e.message : e) + '). Try again in a moment.' }); }
  }
  // the amount read off the pasted invoice; one over the exact balance said at once
  read(text) {
    const a = this.props.invoiceAmount(text);
    const chosen = a.ok ? a.msat : null;
    this.set({ invoice: text, chosen, chosenText: a.ok ? `You withdraw ${satOf(a.msat)}.` : a.why,
      status: a.ok && this.canMsat !== null && a.msat > this.canMsat ? { step: 3, words: TOO_MUCH, kind: 'fail' } : null });
    return chosen;
  }
  async go() {
    const { say, send, onSent } = this.props;
    const chosen = this.read(this.state.invoice);
    const pasted = String(this.state.invoice || '').trim();
    if (!pasted) { say('Paste an invoice first.'); return; }
    if (!chosen) return;
    if (this.canMsat !== null && chosen > this.canMsat) { say(''); this.status(3, TOO_MUCH, 'fail'); return; }
    say('');
    const n = satOf(chosen);
    this.status(0.5, 'Opening your wallet …', 'busy');
    const onStep = (step) => {
      if (/invoice of/.test(step)) this.status(1, 'Checking your invoice …', 'busy');
      else if (/withdrawing over Lightning/.test(step)) this.status(2, `Sending ${n} over Lightning …`, 'busy');
    };
    try {
      const out = await send({ amountMsat: chosen, invoice: pasted, onStep });
      if (out.ok) this.status(3, `Done! ${n} were sent to your Lightning wallet` + (hostOf(out.gateway) ? ` via ${hostOf(out.gateway)}.` : '.'), 'ok');
      else if (out.state === 'Refunded') this.status(3, `The payment could not be completed. Your ${n} are back in your wallet.`, 'fail');
      else if (out.withdrawableMsat != null && chosen > BigInt(out.withdrawableMsat)) this.status(3, TOO_MUCH, 'fail');
      else this.status(3, 'Withdrawal failed: ' + out.why, 'fail');
      if (onSent) onSent();
    } catch (e) { this.status(3, 'Withdrawal failed: ' + (e && e.message ? e.message : e), 'fail'); }
  }
  render() {
    const s = this.state, st = s.status;
    // off until the wallet says how much it can send; off for good at 0
    return (
      <div className={'wd-panel' + (s.usable ? '' : ' empty')}>
        <div className="muted" id="arena-wd-amount">{s.amount}</div>
        <input id="arena-wd-invoice" type="text" autoComplete="off" placeholder="Paste an invoice from your own Lightning wallet" disabled={!s.usable}
          style={{ width: '100%', boxSizing: 'border-box', margin: '6px 0' }} value={s.invoice} onChange={(e) => this.read(e.target.value)} />
        <div className="muted" id="arena-wd-chosen">{s.chosenText}</div>
        <button id="arena-wd-go" type="button" disabled={!s.usable} onClick={() => this.go()}>Withdraw</button>
        {/* WHAT IS HAPPENING NOW, UNDER THE PASTED INVOICE (2026-09-30): one status line and bar */}
        <div className={'pay-status' + (st && st.kind ? ' ' + st.kind : '')} style={st ? undefined : { display: 'none' }}>
          <div className="pay-status-text">{st ? st.words : ''}</div>
          <div className="pay-bar"><div className="pay-bar-fill" style={{ width: `${st ? Math.max(0, Math.min(3, st.step)) / 3 * 100 : 0}%` }} /></div>
        </div>
      </div>);
  }
}
