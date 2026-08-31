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

    [Tooltip("How much of the network this farm is. 0.1 = a tenth.")]
    public float ourShare = 0.10f;

    /// <summary>
    /// What our own miner is worth, in EH/s.
    ///
    /// A share of the network, wandering the way a real farm's reported rate
    /// does - a pool dashboard never shows the same number twice, because it
    /// is a Poisson estimate from found shares and not a measurement.
    /// </summary>
    public float OurExahash
    {
        get
        {
            if (NetworkHashrate <= 0) return 0f;
            float eh = (float)(NetworkHashrate / 1e18 * ourShare);
            float wander = Mathf.Sin(Time.unscaledTime * 0.07f) * 0.035f;
            float flicker = (Mathf.PerlinNoise(Time.unscaledTime * 0.55f, 0.3f) - 0.5f) * 0.05f;
            return eh * (1f + wander + flicker);
        }
    }

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
    }

    public class Mined
    {
        public int height;
        public int nTx;
        public long timestamp;
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
