// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Collections;
using System.Collections.Generic;
using UnityEngine;

/// <summary>
/// Live chain state for the two buildings: what is waiting, what is coming,
/// what has been found, the going rate, and how much hash is pointed at it.
///
/// Kept apart from MempoolFeed, which is the freight list and polls fast. This
/// polls slowly and asks bigger questions, and it uses mempool.space's own /v1
/// endpoints - Esplora does not implement those, so the failover chain steps
/// down to a mirror that does rather than to blockstream.info.
/// </summary>
public class ChainStats : MonoBehaviour
{
    /// <summary>Unconfirmed transactions in the mempool. 0 before the first fetch.</summary>
    public int Unconfirmed { get; private set; }

    /// <summary>Whole-network hashrate in hashes per second.</summary>
    public double NetworkHashrate { get; private set; }

    [Tooltip("Unused. The building showed a tenth of the network as though it " +
             "were one farm's rate; it shows the whole network now, which is " +
             "the figure that is actually worth putting on a wall.")]
    public float ourShare = 1f;

    /// <summary>
    /// The whole network, in EH/s - about 900 at the time of writing.
    ///
    /// It was a tenth of that, presented as this farm's own rate, which is an
    /// invented number standing in front of a real one. The network hashrate
    /// is a fact, it is enormous, and it is the thing a mining building should
    /// be shouting.
    ///
    /// It still wanders, because the reported figure genuinely does: it is a
    /// Poisson estimate from blocks found in a window, not a measurement, and
    /// no dashboard shows the same number twice.
    /// </summary>
    public float Exahash
    {
        get
        {
            if (NetworkHashrate <= 0) return 0f;
            float eh = (float)(NetworkHashrate / 1e18);
            // Restless on purpose, and by a visible amount: at 900 EH/s a
            // wander of two percent moves the last two digits, which is what a
            // real pool dashboard does. A hashrate readout that holds the same
            // number for five minutes reads as a picture of a display rather
            // than a display.
            float wander = Mathf.Sin(Time.unscaledTime * 0.09f) * 0.022f;
            float flicker = (Mathf.PerlinNoise(Time.unscaledTime * 0.7f, 0.3f) - 0.5f) * 0.018f;
            return eh * (1f + wander + flicker);
        }
    }

    /// <summary>Kept so an older reference still compiles.</summary>
    public float OurExahash => Exahash;

    /// <summary>
    /// The four priority tiers, straight from the node.
    ///
    /// I first derived these from the terrain's normalised fee profile times a
    /// constant, which produced numbers that were not so much wrong as
    /// unrelated to anything. mempool.space computes them properly and serves
    /// them; there is no reason to guess.
    /// </summary>
    public int FeeNone { get; private set; }
    public int FeeLow { get; private set; }
    public int FeeMedium { get; private set; }
    public int FeeHigh { get; private set; }
    public bool HasFees { get; private set; }

    public class Projected
    {
        public int nTx;
        public long totalFeeSats;
        public double medianFee;
        public double blockVSize;
        /// <summary>Rough minutes until this one is mined, ten to a block.</summary>
        public int inMinutes;

        /// <summary>
        /// The fee rates paid across this block, cheapest first - mempool's
        /// own feeRange. Eight or nine samples per block, which strung end to
        /// end across the projected blocks is the whole fee curve of the
        /// mempool, live.
        /// </summary>
        public float[] feeRange;
    }

    public class Mined
    {
        public int height;
        public int nTx;
        public long timestamp;

        /// <summary>
        /// What the miner was paid for it.
        ///
        /// The projected blocks carry this and the mined ones did not, so the
        /// two halves of the band described the same thing in different terms
        /// - a block was worth 0.009 BTC before it was mined and nothing at
        /// all afterwards. mempool.space keeps it under extras.totalFees.
        /// </summary>
        public long totalFeeSats;
        public int AgeMinutes =>
            Mathf.Max(0, Mathf.RoundToInt((float)(Now() - timestamp) / 60f));
    }

    public List<Projected> Upcoming { get; private set; } = new();
    public List<Mined> Recent { get; private set; } = new();

    /// <summary>When the unconfirmed count last changed, for the displays.</summary>
    public float CountAge => Time.unscaledTime - _countAt;

    /// <summary>True while the live socket is the one feeding the count.</summary>
    public bool Streaming { get; private set; }

    static long Now() => System.DateTimeOffset.UtcNow.ToUnixTimeSeconds();

    // mempool.space's own socket - the same one their site's counter runs on.
    //
    // The count on the post office has to move every half second, and REST
    // cannot give that: /mempool at 2 requests a second is 172,000 requests a
    // day from one player, which is how a public instance comes to rate-limit
    // the game to a stop. The socket pushes the mempool as it changes and
    // costs one connection, so the display is not merely refreshed often, it
    // is actually current. REST stays underneath it as the fallback for a
    // blocked socket, a mirror that has none, and the first seconds before
    // this one is open.
    const string StreamUrl = "wss://mempool.space/api/v1/ws";
    const string Want = "{\"action\":\"want\",\"data\":[\"stats\",\"blocks\",\"mempool-blocks\"]}";

    WebSocketClient _ws;
    bool _asked;
    float _retry, _lastMessage, _countAt;

    void Start()
    {
        _lastMessage = Time.unscaledTime;
        Connect();
        StartCoroutine(PollMempool());
        StartCoroutine(PollBlocks());
        StartCoroutine(PollFees());
        StartCoroutine(PollHashrate());
    }

    void Connect()
    {
        _ws?.Dispose();
        _ws = new WebSocketClient(StreamUrl);
        _asked = false;
        _retry = Time.unscaledTime + 20f;
    }

    void OnDestroy() => _ws?.Dispose();

    void Update()
    {
        if (_ws == null) return;
        float now = Time.unscaledTime;

        // The socket only sends what it has been asked for, and it can only be
        // asked once it is open.
        if (!_asked && _ws.Status == WebSocketClient.State.Open)
        {
            _ws.Send(Want);
            _asked = true;
            _lastMessage = now;
        }

        foreach (var msg in _ws.Drain()) { _lastMessage = now; Live(msg); }

        // Open but silent counts as dead: that is the failure that actually
        // happens to a websocket, far more often than a clean close.
        bool stale = now - _lastMessage > 45f;
        Streaming = _asked && !stale && _ws.Status == WebSocketClient.State.Open;
        if ((stale || _ws.Status == WebSocketClient.State.Closed
                   || _ws.Status == WebSocketClient.State.Error) && now > _retry)
            Connect();
    }

    /// <summary>
    /// One frame of live chain state.
    ///
    /// Same field names as the REST endpoints - it is the same server - so the
    /// three payloads are read with the same code as their polled twins rather
    /// than a second parser that can drift away from it.
    /// </summary>
    void Live(string msg)
    {
        if (string.IsNullOrEmpty(msg)) return;

        var info = Json.GetRaw(msg, "mempoolInfo");
        if (info != null)
        {
            int n = (int)Json.GetDouble(info, "size");
            if (n > 0) { Unconfirmed = n; _countAt = Time.unscaledTime; }
        }

        // The recommended fees ride along on every stats message, so the
        // building's fee panel never has to ask for them.
        var fees = Json.GetRaw(msg, "fees");
        if (fees != null)
        {
            int fast = (int)System.Math.Ceiling(Json.GetDouble(fees, "fastestFee"));
            if (fast > 0)
            {
                FeeNone = Mathf.Max(1, (int)System.Math.Ceiling(Json.GetDouble(fees, "minimumFee")));
                FeeLow = Mathf.Max(FeeNone, (int)System.Math.Ceiling(
                    Mathf.Max((float)Json.GetDouble(fees, "economyFee"),
                              (float)Json.GetDouble(fees, "hourFee"))));
                FeeMedium = Mathf.Max(FeeLow, (int)System.Math.Ceiling(Json.GetDouble(fees, "halfHourFee")));
                FeeHigh = Mathf.Max(FeeMedium, fast);
                HasFees = true;
            }
        }

        // The whole recent-block row arrives on the first message.
        var found = Json.GetRaw(msg, "blocks");
        if (found != null)
        {
            var list = new List<Mined>();
            foreach (var obj in Json.Elements(found))
            {
                int height = (int)Json.GetDouble(obj, "height");
                if (height <= 0) continue;
                // extras.totalFees, or the flat key if a mirror omits extras.
                var extras = Json.GetRaw(obj, "extras");
                list.Add(new Mined
                {
                    height = height,
                    nTx = (int)Json.GetDouble(obj, "tx_count"),
                    timestamp = (long)Json.GetDouble(obj, "timestamp"),
                    totalFeeSats = (long)Json.GetDouble(
                        string.IsNullOrEmpty(extras) ? obj : extras, "totalFees"),
                });
            }
            if (list.Count > 0)
            {
                // newest first, which is how the row is drawn
                list.Sort((a, b) => b.height.CompareTo(a.height));
                if (list.Count > 8) list.RemoveRange(8, list.Count - 8);
                Recent = list;
            }
        }

        var projected = Json.GetRaw(msg, "mempool-blocks");
        if (projected != null)
        {
            var list = Read(projected);
            if (list.Count > 0) Upcoming = list;
        }

        // A block was just found. Straight onto the front of the row, rather
        // than waiting up to twenty seconds for the poll to notice the thing
        // the whole game is timed against.
        var block = Json.GetRaw(msg, "block");
        if (block != null)
        {
            int height = (int)Json.GetDouble(block, "height");
            if (height > 0 && (Recent.Count == 0 || height > Recent[0].height))
            {
                var row = new List<Mined>(Recent);
                row.Insert(0, new Mined
                {
                    height = height,
                    nTx = (int)Json.GetDouble(block, "tx_count"),
                    timestamp = (long)Json.GetDouble(block, "timestamp"),
                });
                if (row.Count > 8) row.RemoveRange(8, row.Count - 8);
                Recent = row;
            }
        }
    }

    /// <summary>A JSON array of numbers, as floats.</summary>
    static float[] Rates(string array)
    {
        if (array == null) return null;
        var parts = Json.Elements(array);
        if (parts.Count == 0) return null;
        var outp = new float[parts.Count];
        for (int i = 0; i < parts.Count; i++)
            float.TryParse(parts[i].Trim(), System.Globalization.NumberStyles.Float,
                           System.Globalization.CultureInfo.InvariantCulture, out outp[i]);
        return outp;
    }

    /// <summary>
    /// The fee curve of the whole mempool, resampled to as many buckets as the
    /// caller wants: the projected blocks' own fee ranges, laid end to end,
    /// richest first. Null before the first message.
    /// </summary>
    public float[] FeeCurve(int buckets)
    {
        if (buckets <= 0 || Upcoming.Count == 0) return null;

        var flat = new List<float>();
        foreach (var block in Upcoming)
        {
            if (block.feeRange == null || block.feeRange.Length == 0) continue;
            // mempool lists each block's range cheapest first, and the blocks
            // richest first - so reversed within the block, the whole run is
            // one curve falling from the top of the market to the bottom
            for (int i = block.feeRange.Length - 1; i >= 0; i--) flat.Add(block.feeRange[i]);
        }
        if (flat.Count == 0) return null;

        var outp = new float[buckets];
        for (int i = 0; i < buckets; i++)
        {
            int from = Mathf.FloorToInt(i / (float)buckets * flat.Count);
            int to = Mathf.Max(from + 1, Mathf.FloorToInt((i + 1) / (float)buckets * flat.Count));
            float sum = 0f; int n = 0;
            for (int c = from; c < to && c < flat.Count; c++) { sum += flat[c]; n++; }
            outp[i] = n > 0 ? sum / n : 0f;
        }
        return outp;
    }

    /// <summary>The projected-block array, from either transport.</summary>
    static List<Projected> Read(string array)
    {
        var list = new List<Projected>();
        foreach (var obj in Json.Elements(array))
        {
            list.Add(new Projected
            {
                nTx = (int)Json.GetDouble(obj, "nTx"),
                totalFeeSats = (long)Json.GetDouble(obj, "totalFees"),
                medianFee = Json.GetDouble(obj, "medianFee"),
                blockVSize = Json.GetDouble(obj, "blockVSize"),
                inMinutes = list.Count * 10 + 9,
                feeRange = Rates(Json.GetRaw(obj, "feeRange")),
            });
            if (list.Count >= 8) break;
        }
        return list;
    }

    IEnumerator PollMempool()
    {
        while (true)
        {
            // Skipped entirely while the socket is feeding the count - the
            // fallback exists to cover the socket, not to race it.
            if (!Streaming)
                yield return MempoolHosts.Get("/mempool", 10f, text =>
                {
                    if (text == null) return;
                    int n = (int)Json.GetDouble(text, "count");
                    if (n > 0) { Unconfirmed = n; _countAt = Time.unscaledTime; }
                });
            yield return new WaitForSeconds(Streaming ? 30f : 5f);
        }
    }

    IEnumerator PollBlocks()
    {
        while (true)
        {
            yield return MempoolHosts.Get("/v1/fees/mempool-blocks", 12f, text =>
            {
                if (text == null) return;
                var list = Read(text);
                if (list.Count > 0) Upcoming = list;
            });

            if (Streaming && Recent.Count > 0) { yield return new WaitForSeconds(20f); continue; }
            yield return MempoolHosts.Get("/v1/blocks", 12f, text =>
            {
                if (text == null) return;
                var list = new List<Mined>();
                foreach (var obj in Json.Elements(text))
                {
                    list.Add(new Mined
                    {
                        height = (int)Json.GetDouble(obj, "height"),
                        nTx = (int)Json.GetDouble(obj, "tx_count"),
                        timestamp = (long)Json.GetDouble(obj, "timestamp"),
                    });
                    if (list.Count >= 8) break;
                }
                if (list.Count > 0) Recent = list;
            });

            yield return new WaitForSeconds(20f);
        }
    }

    IEnumerator PollFees()
    {
        while (true)
        {
            if (Streaming && HasFees) { yield return new WaitForSeconds(30f); continue; }
            yield return MempoolHosts.Get("/v1/fees/recommended", 10f, text =>
            {
                if (text == null) return;
                int min = (int)Json.GetDouble(text, "minimumFee");
                int eco = (int)Json.GetDouble(text, "economyFee");
                int hour = (int)Json.GetDouble(text, "hourFee");
                int half = (int)Json.GetDouble(text, "halfHourFee");
                int fast = (int)Json.GetDouble(text, "fastestFee");
                if (fast <= 0) return;
                FeeNone = Mathf.Max(1, min);
                FeeLow = Mathf.Max(FeeNone, Mathf.Max(eco, hour));
                FeeMedium = Mathf.Max(FeeLow, half);
                FeeHigh = Mathf.Max(FeeMedium, fast);
                HasFees = true;
            });
            yield return new WaitForSeconds(30f);
        }
    }

    IEnumerator PollHashrate()
    {
        while (true)
        {
            yield return MempoolHosts.Get("/v1/mining/hashrate/3d", 12f, text =>
            {
                if (text == null) return;
                double h = Json.GetDouble(text, "currentHashrate");
                if (h > 0) NetworkHashrate = h;
            });
            yield return new WaitForSeconds(300f);
        }
    }
}
