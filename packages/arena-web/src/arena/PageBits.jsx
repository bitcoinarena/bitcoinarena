// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// SMALL PARTS OF THE ARENA PAGE IN REACT (kanban #564): the refund key's line in an open round (its fingerprint, where the seed came from,
// how to check it, the seed's backup folded away - the restore lives in Settings since 2026-10-04) and the way back to the Arena when a
// game's client is not loaded. Class components; the page hands them their words and its rules.
import React from 'react';

export class RefundKey extends React.Component {
  render() {
    const { fingerprint, imported, roundIdHex, seedHex } = this.props;
    return (
      <>
        {'refund key fingerprint ' + fingerprint
          + (imported ? ' (from the seed you imported)' : ' (from a seed this page made: back it up, or restore your own in Settings)')
          + ' - check it: refund-key.mjs <your seed> ' + roundIdHex}
        <details><summary>seed backup</summary><code>{seedHex}</code></details>
      </>);
  }
}

/** every way back says Arena */
export class BackToArena extends React.Component {
  render() { return <button type="button" className="game" onClick={this.props.onBack}>{'← Arena'}</button>; }
}

/** A line of words the page keeps (a status, a balance, a count): { text } - its element's only content. */
export const Text = ({ text }) => (text === undefined || text === null ? '' : String(text));

/**
 * The history's federation: { say } a line in its place (none named, not readable), else { fed, level, label } - its chip with the dot of
 * its health; a tap copies the id and says "Copied" for 1.2 s.
 */
export class FedChip extends React.Component {
  constructor(p) { super(p); this.state = { copied: false }; }
  componentWillUnmount() { clearTimeout(this.timer); }
  copy() {
    const { fed } = this.props;
    try { navigator.clipboard.writeText(fed).then(() => { this.setState({ copied: true }); clearTimeout(this.timer); this.timer = setTimeout(() => this.setState({ copied: false }), 1200); }); } catch { /* no clipboard */ }
  }
  render() {
    const { say, fed, level = 'idle', label = '' } = this.props;
    if (!fed) return say || '';
    return (
      <span className={`fed-chip ${level}`} title={fed + (label ? ' · ' + label : '') + ' - tap to copy'} onClick={() => this.copy()}>
        {this.state.copied ? 'Copied' : 'Federation ' + fed.slice(0, 8) + '…' + fed.slice(-4)}</span>);
  }
}

/** A popup's backup warning: { line, onBackup } - the words, and the button that closes the popup and opens the 24 words. */
export const BackupBox = ({ line, onBackup }) => <><span>{line}</span><button type="button" onClick={onBackup}>Back up now</button></>;
