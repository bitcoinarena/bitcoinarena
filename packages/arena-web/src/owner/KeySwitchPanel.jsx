// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NODE KEY FROM THE 24 WORDS (kanban #650, 2026-10-25: "b but optional"): a node installed before 2026.1.8 signs with a random
// key kept only on this computer. Optional: move it to the key its words give (POST /owner/key-from-words, signed by the owner) - the plan
// first, then the move. Shown only while the node still signs with the key in its node.db that the words cannot give (2026-10-25:
// "Only display the option to switch when we still have a node.db otherwise it won't show"): checked on load (a words login signs here,
// no prompt), nothing drawn when the key is the words' already or the move is not open to this node. `api` = { post(path, body), signed(action, args) }.
import React from 'react';

const sats = (n) => `${Number(n).toLocaleString('en-US')} sat`;

export class KeySwitchPanel extends React.Component {
  constructor(props) {
    super(props);
    this.state = { step: 'checking', plan: null, message: null, ...(props.initial || {}) };
  }
  componentDidMount() { return this.state.step === 'checking' ? this.check() : undefined; }
  async ask(post) {
    const r = await this.props.api.post('/owner/key-from-words', await this.props.api.signed('key-from-words', { post }));
    if (!r || !r.ok) throw new Error((r && r.why) || 'not possible');
    return r;
  }
  async check() {
    this.setState({ step: 'checking', message: null });
    try {
      const r = await this.ask(false);
      this.setState(r.already ? { step: 'hidden' } : { step: 'review', plan: r.plan });
    } catch (e) {
      // the move is open but the wallet is short: said, with what it needs; anything else (the words' key already, Nostr, a guardian): nothing
      this.setState(/plus fees/.test(e.message) ? { step: 'short', message: e.message } : { step: 'hidden' });
    }
  }
  async move() {
    this.setState({ step: 'sending', message: null });
    try {
      const r = await this.ask(true);
      this.setState({ step: 'moved', txid: r.bond && r.bond.txid });
    } catch (e) { this.setState({ step: 'review', message: e.message }); }
  }
  render() {
    const { step, plan, message, txid } = this.state;
    if (step === 'checking' || step === 'hidden') return null;
    return (
      <div className="card" id="keyswitch">
        <h3>Your node's key and your 24 words</h3>
        {step === 'moved' ? <p className="ok">Done. Your node now uses the key from your 24 words and restarts with it. New bond: <span className="mono">{String(txid || '').slice(0, 16)}…</span> (counts after 6 blocks).</p>
          : <>
            <p>Nodes set up before version 2026.1.8 sign with a key that lives only on this computer. If it is lost, your 24 words cannot bring the node back.
              You can move your node to the key your words give. This is optional.</p>
            {plan ? <>
              <ul>
                <li>A new bond of <b>{sats(plan.bondSats)}</b> from your node's wallet, under the new key (fees {sats(plan.fees)}).</li>
                <li>Your old bond stays locked until block {Number(plan.oldBonds[0].maturity).toLocaleString('en-US')}, then you take it back.</li>
                <li>Your node restarts with the new key. Other nodes know it by that key once the new bond counts (6 blocks).</li>
              </ul>
              <button type="button" className="primary" id="keyswitch-move" onClick={() => this.move()}>Move to the key from my words</button>
            </> : null}
            {step === 'sending' ? <p className="sub">Posting the new bond…</p> : null}
            {message ? <p className="err">{message}</p> : null}
          </>}
      </div>);
  }
}
