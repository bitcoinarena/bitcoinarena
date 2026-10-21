// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Collections;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

/// <summary>
/// Hits the real Binance socket. Network tests are a trade-off, but the whole
/// point of this game is that the battlefield is the live tape - a mock would
/// verify the mock. If there is no network the test says so rather than
/// failing, so an offline run does not look like a broken build.
/// </summary>
public class LiveFeedTests
{
    [UnityTest]
    public IEnumerator BinanceDeliversARealPrice()
    {
        var go = new GameObject("Feed");
        var feed = go.AddComponent<MarketFeed>();

        float waited = 0f;
        while (waited < 25f && feed.Price <= 0) { yield return new WaitForSeconds(0.5f); waited += 0.5f; }

        if (feed.Price <= 0)
        {
            Debug.Log($"[LiveFeedTests] no price after {waited:0}s, status={feed.Status} - treating as offline");
            Assert.Ignore("no network");
        }

        Debug.Log($"[LiveFeedTests] BTC {feed.Price:N2} status={feed.Status} after {waited:0.0}s");
        Assert.Greater(feed.Price, 1000, "price is implausible");
        Assert.Less(feed.Price, 10_000_000, "price is implausible");
        Object.Destroy(go);
    }

    [UnityTest]
    public IEnumerator FrontlineFollowsTheTape()
    {
        var go = new GameObject("Field");
        var terrainGo = new GameObject("T");
        terrainGo.AddComponent<MeshFilter>(); terrainGo.AddComponent<MeshRenderer>(); terrainGo.AddComponent<MeshCollider>();
        var terrain = terrainGo.AddComponent<MempoolTerrain>();

        var field = go.AddComponent<Battlefield>();
        field.terrain = terrain;
        field.market = go.AddComponent<MarketFeed>();

        yield return new WaitForSeconds(6f);

        Assert.IsTrue(field.History.Seeded, "history never seeded - the map would be flat");
        float z0 = field.FrontlineZ(-100f), z1 = field.FrontlineZ(100f);
        Assert.IsFalse(float.IsNaN(z0) || float.IsNaN(z1), "frontline went NaN");
        Assert.LessOrEqual(Mathf.Abs(z0), terrain.depth * 0.5f);
        Assert.LessOrEqual(Mathf.Abs(z1), terrain.depth * 0.5f);
        Debug.Log($"[LiveFeedTests] frontline z(-100)={z0:0.0} z(100)={z1:0.0}");

        Object.Destroy(go); Object.Destroy(terrainGo);
    }
}
