// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE MARKET'S CODE EDITOR (kanban #920): a plain textarea over a coloured copy of its text, with line numbers and the lines the check refuses marked.
import React from 'react';

const WORDS = 'const|let|var|function|return|if|else|for|while|of|in|new|true|false|null|undefined|break|continue|typeof|switch|case|default|try|catch|throw';
const TOKEN = new RegExp(`(//[^\\n]*|/\\*[\\s\\S]*?\\*/)|('(?:[^'\\\\\\n]|\\\\.)*'|"(?:[^"\\\\\\n]|\\\\.)*"|\`(?:[^\`\\\\]|\\\\.)*\`)|\\b(${WORDS})\\b|\\b(\\d+(?:\\.\\d+)?)\\b|\\b([A-Za-z_$][\\w$]*)(?=\\()`, 'g');

/** The text as coloured pieces. Comments, strings, keywords, numbers, called names. */
export function colours(text) {
  const out = []; let at = 0, m; TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(text))) {
    if (m.index > at) out.push(text.slice(at, m.index));
    const kind = m[1] !== undefined ? 'c' : m[2] !== undefined ? 's' : m[3] !== undefined ? 'k' : m[4] !== undefined ? 'n' : 'f';
    out.push(<span key={m.index} className={`ce-${kind}`}>{m[0]}</span>);
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

export class CodeEditor extends React.Component {
  keys(e) {
    if (e.key !== 'Tab' || e.shiftKey) return;
    e.preventDefault();
    const a = e.target, { selectionStart: s, selectionEnd: f, value } = a;
    this.props.onChange(`${value.slice(0, s)}  ${value.slice(f)}`);
    requestAnimationFrame(() => { a.selectionStart = a.selectionEnd = s + 2; });
  }
  scroll(e) { if (this.back) { this.back.scrollTop = e.target.scrollTop; this.back.scrollLeft = e.target.scrollLeft; } if (this.lines) this.lines.scrollTop = e.target.scrollTop; }
  render() {
    const { value, onChange, marked = [] } = this.props;
    const n = value.split('\n').length;
    return (
      <div className="ce">
        <div className="ce-lines" aria-hidden="true" ref={(x) => { this.lines = x; }}>{Array.from({ length: n }, (x, i) => <span key={i} className={marked.includes(i + 1) ? 'bad' : undefined}>{i + 1}</span>)}</div>
        <div className="ce-area">
          <pre aria-hidden="true" ref={(x) => { this.back = x; }}>{colours(value)}{'\n'}</pre>
          <textarea aria-label="Code" spellCheck={false} autoCapitalize="none" autoComplete="off" autoCorrect="off" wrap="off" value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => this.keys(e)} onScroll={(e) => this.scroll(e)} />
        </div>
      </div>);
  }
}
