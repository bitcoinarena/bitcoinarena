// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Collections.Generic;
using UnityEngine;

/// <summary>
/// The transactions in the next projected block, live, from mempool.space's
/// own socket - the same feed their block-overview graph runs on.
///
/// The goggles wall was being drawn from MempoolFeed, which is the freight
/// list: forty transactions off /mempool/recent, refetched every twelve
/// seconds. Forty is enough to load a truck with and nowhere near enough to
/// look like a block, and twelve seconds is not "live" by any reading - the
/// wall was a still life that changed four times a minute.
///
/// So this subscribes the way their front end does:
///
///     -> {"track-mempool-block": 0}
///     &lt;- {"projected-block-transactions": {"index":0,"blockTransactions":[[...], ...]}}
///     &lt;- {"projected-block-transactions": {"index":0,"delta":{"added":[[...]],"removed":[txid]}}}
///
/// The full list arrives once, then deltas every couple of seconds - about a
/// hundred transactions in and a hundred out each time, which is what the
/// mempool is actually doing. Each transaction is a compact array rather than
/// an object:
///
///     [txid, fee, vsize, value, effectiveRate, flags, time]
/// </summary>
public class MempoolBlockStream : MonoBehaviour
{
    public class Tx
    {
        public string txid;
        public long feeSats;
        public float vsize;
        public float rate;          // sat/vB, the effective rate the block pays
    }

    const string Url = "wss://mempool.space/api/v1/ws";

    [Tooltip("Which projected block to watch. 0 is the one being built now.")]
    public int block = 0;

    [Tooltip("Cap on how many transactions are held - a safety net, not a " +
             "filter. A projected block runs to five or six thousand and all " +
             "of them belong on the wall: keeping only the largest inflates " +
             "every one of them, because each tile is sized as a share of the " +
             "total that IS kept, and a block missing its 4000 small " +
             "transactions makes the big ones look twice their real weight.")]
    public int keep = 8000;

    /// <summary>Everything in the projected block, largest first. Never null.</summary>
    public List<Tx> Transactions { get; private set; } = new();

    /// <summary>Bumped whenever the set changes, so a view can watch one int.</summary>
    public int Version { get; private set; }

    /// <summary>True once the socket has delivered a block.</summary>
    public bool Live { get; private set; }

    public string Status { get; private set; } = "connecting";

    readonly Dictionary<string, Tx> _byId = new();
    WebSocketClient _ws;
    bool _asked;
    float _retry, _lastMessage;

    void Start()
    {
        _lastMessage = Time.unscaledTime;
        Connect();
    }

    void OnDestroy() => _ws?.Dispose();

    void Connect()
    {
        _ws?.Dispose();
        _ws = new WebSocketClient(Url);
        _asked = false;
        _retry = Time.unscaledTime + 20f;
        Status = "connecting";
    }

    void Update()
    {
        if (_ws == null) return;
        float now = Time.unscaledTime;

        if (!_asked && _ws.Status == WebSocketClient.State.Open)
        {
            _ws.Send("{\"track-mempool-block\":" + Mathf.Max(0, block) + "}");
            _asked = true;
            _lastMessage = now;
        }

        bool changed = false;
        foreach (var msg in _ws.Drain())
        {
            _lastMessage = now;
            changed |= Read(msg);
        }
        if (changed) Sort();

        bool stale = now - _lastMessage > 60f;
        Status = Live && !stale ? $"{_byId.Count} tx" : stale ? "stale" : "connecting";
        if ((stale || _ws.Status == WebSocketClient.State.Closed
                   || _ws.Status == WebSocketClient.State.Error) && now > _retry)
            Connect();
    }

    bool Read(string msg)
    {
        var body = Json.GetRaw(msg, "projected-block-transactions");
        if (body == null) return false;

        var full = Json.GetRaw(body, "blockTransactions");
        if (full != null)
        {
            _byId.Clear();
            AddAll(full);
            Live = true;
            return true;
        }

        var delta = Json.GetRaw(body, "delta");
        if (delta == null) return false;

        bool changed = false;
        var removed = Json.GetRaw(delta, "removed");
        if (removed != null)
            foreach (var id in Json.Elements(removed))
                changed |= _byId.Remove(Unquote(id));

        var added = Json.GetRaw(delta, "added");
        if (added != null) changed |= AddAll(added);

        // "changed" is NOT the same shape, and reading it as though it were
        // is what put a transaction of 1.1 trillion vbytes on the wall: its
        // rows are [txid, rate, ...] rather than [txid, fee, vsize, ...], so
        // the flags field landed in the vsize and one bogus tile took a third
        // of the panel and set the scale for everything else. A re-price only
        // ever changes the colour of something already there.
        var repriced = Json.GetRaw(delta, "changed");
        if (repriced != null)
            foreach (var r in Json.Elements(repriced))
                changed |= Reprice(r);

        if (changed) Live = true;
        return changed;
    }

    /// <summary>A re-priced transaction: [txid, rate, ...]. Colour only.</summary>
    bool Reprice(string row)
    {
        if (string.IsNullOrEmpty(row)) return false;
        int i = row.IndexOf('"');
        int j = i < 0 ? -1 : row.IndexOf('"', i + 1);
        if (j < 0) return false;

        var id = row.Substring(i + 1, j - i - 1);
        if (!_byId.TryGetValue(id, out var tx)) return false;

        var bits = row.Substring(j + 1).TrimStart(',', ' ').TrimEnd(']', ' ').Split(',');
        float rate = (float)Number(bits, 0);
        if (rate <= 0f) return false;
        tx.rate = rate;
        return true;
    }

    bool AddAll(string array)
    {
        bool any = false;
        foreach (var row in Json.Elements(array))
        {
            var tx = Parse(row);
            if (tx == null) continue;
            _byId[tx.txid] = tx;
            any = true;
        }
        return any;
    }

    /// <summary>
    /// One compact row: ["txid", fee, vsize, value, rate, flags, time].
    ///
    /// Hand-parsed rather than run through a JSON tree. This arrives a
    /// thousand rows at a time, several times a minute, and the whole point of
    /// the compact form is that it is cheap to read.
    /// </summary>
    public static Tx Parse(string row)
    {
        if (string.IsNullOrEmpty(row)) return null;
        int i = row.IndexOf('"');
        if (i < 0) return null;
        int j = row.IndexOf('"', i + 1);
        if (j < 0) return null;

        var tx = new Tx { txid = row.Substring(i + 1, j - i - 1) };
        var rest = row.Substring(j + 1).TrimStart(',', ' ').TrimEnd(']', ' ');
        var bits = rest.Split(',');
        if (bits.Length < 3) return null;

        tx.feeSats = (long)Number(bits, 0);
        tx.vsize = (float)Number(bits, 1);
        // A transaction is between 100 vB and a full block. Anything outside
        // that is a row this parser has misread, and one of those sets the
        // scale for every tile on the wall.
        if (tx.vsize < 10f || tx.vsize > 4_000_000f) return null;
        // the effective rate, which is what the block actually pays for it -
        // a child paying for its parent is not priced by its own fee
        float rate = (float)Number(bits, 3);
        tx.rate = rate > 0f ? rate : (tx.vsize > 0f ? tx.feeSats / tx.vsize : 0f);
        return tx.vsize > 0f ? tx : null;
    }

    static double Number(string[] bits, int at)
        => at < bits.Length && double.TryParse(bits[at].Trim(),
               System.Globalization.NumberStyles.Float,
               System.Globalization.CultureInfo.InvariantCulture, out var v) ? v : 0.0;

    static string Unquote(string s)
        => string.IsNullOrEmpty(s) ? s : s.Trim().Trim('"');

    void Sort()
    {
        var list = new List<Tx>(_byId.Values);
        // largest first: that is both mempool's own order and what makes the
        // packer produce a tight arrangement
        list.Sort((a, b) => b.vsize.CompareTo(a.vsize));
        if (list.Count > keep) list.RemoveRange(keep, list.Count - keep);
        Transactions = list;
        Version++;
    }
}
