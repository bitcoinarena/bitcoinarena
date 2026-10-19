// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Collections;
using System.Collections.Generic;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

/// <summary>
/// The ramp has to be usable straight away.
///
/// Reported as "the packages take ten seconds to appear": the bay opens the
/// moment the truck spawns, and the mempool takes seconds to answer, so the
/// player sat in front of an empty ramp with nothing to pick and no way to
/// leave. These tests deliberately do NOT seed the feed - the point is what
/// happens before any network reply.
/// </summary>
public class RampReadyTests
{
    [TearDown] public void ClearTheWorld() => TestWorld.TearDown();

    GameObject _boot;

    [UnityTearDown]
    public IEnumerator TearDown()
    {
        Time.timeScale = 1f;
        foreach (var go in Object.FindObjectsByType<GameObject>(FindObjectsSortMode.None))
            if (go.transform.parent == null) Object.Destroy(go);
        yield return null;
    }

    [UnityTest]
    public IEnumerator TheRampCarriesFreightWithinAFewFrames()
    {
        _boot = new GameObject("Bootstrap");
        _boot.AddComponent<Bootstrap>();

        // a handful of frames, not a handful of seconds
        for (int i = 0; i < 6; i++) yield return null;

        // past the title screen: it holds the truck and the ramp until PLAY
        var splash0 = Object.FindFirstObjectByType<SplashScreen>();
        if (splash0 != null && splash0.Showing) splash0.Play();
        yield return null;

        var yard = Object.FindFirstObjectByType<PackageYard>();
        Assert.IsNotNull(yard, "keine Laderampe");
        Assert.IsTrue(yard.IsOpen, "die Rampe ist zu");

        var caps = yard.Captions();
        Assert.Greater(caps.Count, 0,
            "die Rampe ist leer, solange der Mempool noch nicht geantwortet hat - " +
            "der Spieler steht ohne Auswahl da");

        foreach (var c in caps)
        {
            Assert.Greater(c.tx.vsize, 0, "ein Platzhalter-Paket hat keine Groesse");
            Assert.Greater(c.tx.FeeRate, 0f, "ein Platzhalter-Paket hat keine Gebuehrenrate");
        }
    }

    [UnityTest]
    public IEnumerator TheRealTransactionsReplaceTheStandInsWhileNothingIsLoaded()
    {
        _boot = new GameObject("Bootstrap");
        _boot.AddComponent<Bootstrap>();
        for (int i = 0; i < 6; i++) yield return null;

        // past the title screen: it holds the truck and the ramp until PLAY
        var splash0 = Object.FindFirstObjectByType<SplashScreen>();
        if (splash0 != null && splash0.Showing) splash0.Play();
        yield return null;

        var feed = Object.FindFirstObjectByType<MempoolFeed>();
        var yard = Object.FindFirstObjectByType<PackageYard>();
        var before = yard.Captions()[0].tx.txid;

        // the reply lands
        feed.Offers = new List<MempoolFeed.Tx>
        {
            new MempoolFeed.Tx { txid = "real0000000000000000000000000001",
                                 feeSats = 8000, vsize = 250, valueSats = 900_000_000 },
            new MempoolFeed.Tx { txid = "real0000000000000000000000000002",
                                 feeSats = 3000, vsize = 300, valueSats = 200_000_000 },
        };
        yield return null; yield return null;

        var now = yard.Captions();
        Assert.AreEqual(2, now.Count, "die echten Transaktionen kommen nicht auf die Rampe");
        Assert.AreNotEqual(before, now[0].tx.txid, "die Platzhalter stehen noch da");
    }

    [UnityTest]
    public IEnumerator ArrivingTransactionsDoNotSnatchAwayALoadedPackage()
    {
        _boot = new GameObject("Bootstrap");
        _boot.AddComponent<Bootstrap>();
        for (int i = 0; i < 6; i++) yield return null;

        // past the title screen: it holds the truck and the ramp until PLAY
        var splash0 = Object.FindFirstObjectByType<SplashScreen>();
        if (splash0 != null && splash0.Showing) splash0.Play();
        yield return null;

        var feed = Object.FindFirstObjectByType<MempoolFeed>();
        var yard = Object.FindFirstObjectByType<PackageYard>();
        var bay = Object.FindFirstObjectByType<CargoBay>();

        var picked = yard.Captions()[0].tx;
        Assert.IsTrue(yard.Toggle(picked), "das Paket liess sich nicht laden");
        yield return null;

        feed.Offers = new List<MempoolFeed.Tx>
        {
            new MempoolFeed.Tx { txid = "late000000000000000000000000001",
                                 feeSats = 8000, vsize = 250, valueSats = 900_000_000 },
        };
        yield return null; yield return null;

        Assert.IsTrue(bay.Contains(picked.txid),
            "die eintreffenden Transaktionen haben die Ladung vom Truck genommen");
    }
}
