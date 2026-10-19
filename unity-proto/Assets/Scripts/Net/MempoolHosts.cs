// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Collections;
using UnityEngine;
using UnityEngine.Networking;

/// <summary>
/// Where mempool data comes from, and what to do when that place is down.
///
/// Three components fetch from mempool.space independently - the terrain, the
/// block clock and the freight list - and each of them had the host as its own
/// field. When mempool.space went down the game did not degrade, it simply had
/// no world: no terrain heights, no block, no cargo to pick.
///
/// So the host is a list, not a string, and it is shared. The endpoints used
/// here are Esplora's, which mempool.space implements and Blockstream serves
/// natively, so the same three paths work against every entry:
///
///     /mempool            /blocks/tip/height            /mempool/recent
///
/// The working host is remembered across calls. Without that, every request
/// during an outage would pay the full timeout on the dead host first, and
/// three components polling on their own timers would spend the whole session
/// re-discovering the same failure.
/// </summary>
public static class MempoolHosts
{
    /// <summary>
    /// In preference order. All three answer with CORS wide open, which a
    /// WebGL build needs - a mirror that refuses the browser is no mirror at
    /// all, however healthy the server is.
    ///
    /// mempool.bisq.services is deliberately absent: it is widely listed as an
    /// official instance and it no longer resolves.
    /// </summary>
    public static readonly string[] All =
    {
        "https://mempool.space/api",
        "https://mempool.emzy.de/api",
        "https://blockstream.info/api",
    };

    /// <summary>Index of the host that answered last. Tried first next time.</summary>
    static int _preferred;

    /// <summary>The host currently trusted, for diagnostics.</summary>
    public static string Current => All[Mathf.Clamp(_preferred, 0, All.Length - 1)];

    /// <summary>How many times the chain has had to fall through this session.</summary>
    public static int Failovers { get; private set; }

    /// <summary>
    /// GET <paramref name="path"/> from the first host that answers.
    ///
    /// Starts at the remembered host and wraps, so a failover is sticky rather
    /// than a per-request retry. <paramref name="body"/> is null if every host
    /// failed, which callers must treat as "keep the last good data" rather
    /// than "the mempool is empty" - an empty mempool is a legal answer and a
    /// dead network is not.
    /// </summary>
    public static IEnumerator Get(string path, float timeout, System.Action<string> body)
    {
        for (int i = 0; i < All.Length; i++)
        {
            int at = (_preferred + i) % All.Length;
            using (var req = UnityWebRequest.Get(All[at] + path))
            {
                req.timeout = Mathf.Max(1, Mathf.RoundToInt(timeout));
                // Some instances refuse the default UnityWebRequest agent - but
                // NOT in a browser, where User-Agent is a forbidden header: the
                // browser owns it, setting it does nothing, and it earns a
                // console warning on every single request.
#if !UNITY_WEBGL || UNITY_EDITOR
                req.SetRequestHeader("User-Agent", "btc-logistics-war");
#endif
                yield return req.SendWebRequest();

                if (req.result == UnityWebRequest.Result.Success)
                {
                    if (at != _preferred)
                    {
                        Failovers++;
                        Debug.LogWarning($"[MempoolHosts] {All[_preferred]} failed, " +
                                         $"switched to {All[at]}");
                        _preferred = at;
                    }
                    body(req.downloadHandler.text);
                    yield break;
                }
            }
        }

        Debug.LogWarning($"[MempoolHosts] every host failed for {path}");
        body(null);
    }
}
