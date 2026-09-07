using System.Collections;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Networking;

/// <summary>
/// The transactions currently waiting in the mempool - the freight on offer.
///
/// /api/mempool/recent returns the newest arrivals as
/// [{"txid":..,"fee":..,"vsize":..,"value":..}, ...]. Fee rate is the thing
/// the game is actually about, so it is derived once here rather than at every
/// use site.
/// </summary>
public class MempoolFeed : MonoBehaviour
{
    [Tooltip("Unused - see MempoolHosts. Kept so an existing scene reference " +
             "does not break.")]
    public string mempoolApi = "https://mempool.space/api";
    public float refreshSeconds = 12f;

    [Tooltip("How many are kept on offer. The ramp shows most of them and " +
             "holds the rest back as a queue, so freight never runs out with " +
             "the bed half empty.")]
    public int keep = 40;

    public class Tx
    {
        public string txid;
        public long feeSats;
        public int vsize;
        public long valueSats;

        /// <summary>sat/vB - what the next block is being paid for it.</summary>
        public float FeeRate => vsize > 0 ? feeSats / (float)vsize : 0f;
        public double Btc => valueSats / 1e8;

        /// <summary>Short form, the way a block explorer shows it.</summary>
        public string Short => txid != null && txid.Length > 10
            ? txid.Substring(0, 6) + "…" + txid.Substring(txid.Length - 4)
            : txid ?? "—";

        /// <summary>A big mover. Worth more, and worth more to lose.</summary>
        public bool Whale => Btc >= 25.0;
    }

    /// <summary>
    /// What is on offer right now. Never null. Settable so a test can work
    /// from a fixed list instead of whatever the mempool happens to hold at
    /// the moment the test runs.
    /// </summary>
    public List<Tx> Offers { get; set; } = new List<Tx>();

    /// <summary>True once real transactions have arrived.</summary>
    public bool Fresh { get; private set; }

    public string Status { get; private set; } = "connecting …";

    /// <summary>
    /// Freight on the ramp from the first frame.
    ///
    /// The loading bay opens the moment the truck spawns, and the mempool
    /// takes seconds to answer - so the player sat in front of an empty ramp
    /// for ten seconds with nothing to pick and no way to leave. A stand-in
    /// yard is built immediately and replaced by the real transactions when
    /// they land, which the panel only does while nothing has been loaded, so
    /// the swap can never take a package out from under the player.
    /// </summary>
    void Awake()
    {
        Offers = Synthetic(keep);
        Status = "loading the mempool …";
    }

    void Start() => StartCoroutine(Poll());

    IEnumerator Poll()
    {
        while (true)
        {
            yield return MempoolHosts.Get("/mempool/recent", 10f, text =>
            {
                if (text != null)
                {
                    var parsed = Parse(text, keep);
                    // Only replace a good list with another good one. A blank
                    // reply must not empty the yard while the player is looking
                    // at it.
                    if (parsed.Count > 0)
                    {
                        Offers = Merge(parsed);
                        Fresh = true;
                        Status = $"{Offers.Count} tx";
                    }
                }
                else
                {
                    // the stand-in yard is already up; just say so
                    Status = Fresh ? "stale" : "offline";
                }
            });
            // Quick to begin with, so the ramp fills from ten to twenty-one
            // within the first half minute, then settle to the normal beat.
            yield return new WaitForSeconds(Offers.Count < 24 ? 2.5f : refreshSeconds);
        }
    }

    /// <summary>
    /// Fold a fresh reply into what is already on offer.
    ///
    /// /api/mempool/recent returns only the last ten arrivals, and the loading
    /// ramp shows twenty-one - so a single reply can never fill it. New
    /// transactions are accumulated across polls, oldest dropped once the pool
    /// is full, which is also closer to what a mempool is: a queue that things
    /// join and leave rather than a snapshot of ten.
    ///
    /// The first replacement is wholesale: the stand-in yard has to go the
    /// moment real freight arrives, not be mixed with it.
    /// </summary>
    List<Tx> Merge(List<Tx> arrived)
    {
        if (!Fresh) return arrived;                 // the stand-ins go entirely

        var pool = new List<Tx>(Offers);
        var have = new HashSet<string>();
        foreach (var t in pool) have.Add(t.txid);

        foreach (var t in arrived)
            if (have.Add(t.txid)) pool.Insert(0, t);   // newest at the front

        if (pool.Count > keep) pool.RemoveRange(keep, pool.Count - keep);
        return pool;
    }

    public static List<Tx> Parse(string json, int keep)
    {
        var list = new List<Tx>();
        foreach (var el in Json.Elements(json))
        {
            var tx = new Tx
            {
                txid = Json.GetString(el, "txid"),
                feeSats = (long)Json.GetDouble(el, "fee"),
                vsize = (int)Json.GetDouble(el, "vsize"),
                valueSats = (long)Json.GetDouble(el, "value"),
            };
            if (string.IsNullOrEmpty(tx.txid) || tx.vsize <= 0) continue;
            list.Add(tx);
            if (list.Count >= keep) break;
        }
        return list;
    }

    /// <summary>
    /// Something to load when the API cannot be reached. The yard being empty
    /// would block the player behind a network failure with nothing to pick.
    /// </summary>
    static List<Tx> Synthetic(int n)
    {
        var list = new List<Tx>();
        for (int i = 0; i < n; i++)
        {
            int vsize = Random.Range(140, 900);
            list.Add(new Tx
            {
                txid = System.Guid.NewGuid().ToString("N").Substring(0, 32),
                vsize = vsize,
                feeSats = (long)(vsize * Random.Range(1.2f, 90f)),
                valueSats = (long)(Random.Range(0.002f, 40f) * 1e8f),
            });
        }
        return list;
    }
}
