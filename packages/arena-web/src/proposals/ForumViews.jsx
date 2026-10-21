// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PROPOSALS FORUM'S READING VIEWS IN REACT (kanban #564, slice 1 of src/arena-ui/proposals): the thread list and one thread. The
// forum's own script (forum.js) still reads the nodes, keeps the player's in-game key and signs and posts; it hands these class
// components plain view data - names, stages, amounts, and a proposal's text as the HTML its own Markdown made (escaped there) - and
// gets the reply back. The new-proposal, fees and payout forms stay its own for now.
import React from 'react';

const Stage = ({ s }) => <span className={`stage ${s.cls}`}>{s.text}</span>;
const Avatar = ({ a }) => <div className="ava" style={{ background: a.colour }}>{a.initial}</div>;

/** The thread list: { status, items: [{ pip, title, by, amount, replies, stage: { cls, text }, href }] or null while reading }. */
export function ProposalList({ status, items }) {
  return (
    <div>
      <div className="bar"><span className="say">{status}</span><a className="btn primary grow" href="#new">New proposal</a></div>
      <div className="topics">
        <div className="th"><span>Proposal</span><span className="n">Amount</span><span className="n">Replies</span><span className="n">Stage</span></div>
        {items && !items.length ? <div className="empty">No proposals yet. Start the first one.</div> : null}
        {(items || []).map((p) => (
          <a key={p.pip} className="topic" href={p.href}>
            <span className="t"><span className="pip">{`PIP-${p.pip}`}</span> {p.title}<span className="by">{p.by}</span></span>
            <span className="amt">{p.amount}</span><span className="n">{p.replies}</span><Stage s={p.stage} />
          </a>))}
      </div>
    </div>);
}

function Post({ p, depth, children }) {
  return (
    <article className={`post${depth ? ' reply' : ''}`} style={depth ? { '--depth': Math.min(depth, 4) } : undefined}>
      <Avatar a={p.avatar} />
      <div>
        <div className="who"><b title={p.npub}>{p.name}</b> · {p.head}</div>
        {p.html !== undefined ? <div className="body md" dangerouslySetInnerHTML={{ __html: p.html }} /> : <div className="body">{p.text}</div>}
        {children}
      </div>
    </article>);
}

/**
 * One thread: { thread: null (not held) | { heading, amount, lnurl, stage, stageLine, post, comments: [{ id, depth, ...post }] }, status,
 * onReply(text, parentId) -> Promise<{ ok, say }> }. A reply goes to the post named by its Reply button, else to the proposal.
 */
export class ProposalThread extends React.Component {
  constructor(props) { super(props); this.state = { text: '', replyTo: null, replyName: null, say: '', bad: false, busy: false }; this.send = this.send.bind(this); this.box = React.createRef(); }
  async send(e) {
    e.preventDefault();
    if (!this.state.text.trim()) return;
    this.setState({ busy: true, say: 'Sending…', bad: false });
    const r = await this.props.onReply(this.state.text, this.state.replyTo);
    this.setState(r.ok ? { busy: false, say: r.say, bad: false, text: '', replyTo: null, replyName: null } : { busy: false, say: r.say, bad: true });
  }
  render() {
    const { thread: t, status } = this.props;
    const { text, replyName, say, bad, busy } = this.state;
    return (
      <div>
        <div className="bar"><a className="btn" href="#">← All proposals</a></div>
        {!t ? <div className="empty">{status}</div> : (
          <>
            <h1>{t.heading}</h1>
            <Post p={t.post} depth={0}>
              <div className="facts"><span><b>{t.amount}</b> to {t.lnurl}</span><Stage s={t.stage} /><span>{t.stageLine}</span></div>
            </Post>
            {t.comments.map((c) => (
              <Post key={c.id} p={c} depth={c.depth}>
                <div className="acts"><button type="button" onClick={() => { this.setState({ replyTo: c.id, replyName: c.name }); if (this.box.current) this.box.current.focus(); }}>Reply</button></div>
              </Post>))}
            <form className="compose" onSubmit={this.send}>
              <textarea ref={this.box} rows={4} maxLength={4000} value={text} placeholder={replyName ? `Reply to ${replyName}` : 'Write a reply'} onChange={(e) => this.setState({ text: e.target.value })} />
              <div className="bar"><button type="submit" className="btn primary" disabled={busy}>Post reply</button><span className={`say${bad ? ' bad' : ''}`}>{say}</span></div>
            </form>
          </>)}
      </div>);
  }
}
