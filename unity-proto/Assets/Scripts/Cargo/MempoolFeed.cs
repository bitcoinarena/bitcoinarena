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
    public string mempoolApi = "https://mempool.space/api";
    public float refreshSeconds = 12f;

    [Tooltip("How many are kept on offer. More than this is a wall of hex.")]
    public int keep = 14;

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

    public string Status { get; private set; } = "verbinde …";

    void Start() => StartCoroutine(Poll());

    IEnumerator Poll()
    {
        while (true)
        {
            using (var req = UnityWebRequest.Get(mempoolApi + "/mempool/recent"))
            {
                yield return req.SendWebRequest();
                if (req.result == UnityWebRequest.Result.Success)
                {
                    var parsed = Parse(req.downloadHandler.text, keep);
                    // Only replace a good list with another good one. A blank
                    // reply must not empty the yard while the player is looking
                    // at it.
                    if (parsed.Count > 0)
                    {
                        Offers = parsed;
                        Fresh = true;
                        Status = $"{parsed.Count} tx";
                    }
                }
                else
                {
                    Status = req.error;
                    if (!Fresh) { Offers = Synthetic(keep); Status = "offline"; }
                }
            }
            yield return new WaitForSeconds(refreshSeconds);
        }
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
