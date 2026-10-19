// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Collections;
using Arena;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

/// <summary>
/// THE SEAM: how two liquidations get into one frame at all.
///
/// The two ends were already measured. The core cannot make two strikes out of
/// two same-frame liquidations - two `submitLiquidation` calls before a tick
/// move the strike serial by one, dig one crater and load it with the larger,
/// in either order - and `StrikeLatchTests` forces the renderer's half of that
/// rule. What neither covers is the wire between them: that `MarketFeed` takes
/// two forced orders in ONE drain and that `Bootstrap` hands both of them to
/// the latch.
///
/// This needs a frame loop, so it is PlayMode: EditMode never runs `Update`,
/// and the drain lives there. Nothing is asked of the network - the frames are
/// put into the socket's own queue with `Deliver`, which is what the wire would
/// have done, because waiting for a real double arrival took twenty passive
/// minutes and produced none (0.10 liquidations a minute).
/// </summary>
public class StrikeSeamTests
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

    /// <summary>A Binance forced order. SELL closes a long, BUY closes a short.</summary>
    static string Order(string side, double qty, double price) =>
        "{\"stream\":\"!forceOrder@arr\",\"data\":{\"e\":\"forceOrder\",\"o\":{" +
        "\"s\":\"BTCUSDT\",\"S\":\"" + side + "\"," +
        "\"q\":\"" + qty.ToString(System.Globalization.CultureInfo.InvariantCulture) + "\"," +
        "\"ap\":\"" + price.ToString(System.Globalization.CultureInfo.InvariantCulture) + "\"}}}";

    const bool Bear = true, Bull = false;

    static string Long1M => Order("SELL", 20, 50000);    // a bull blown out, $1,000,000
    static string Short5M => Order("BUY", 100, 50000);   // a bear blown out, $5,000,000

    MarketFeed _feed;
    StrikeTheatre _theatre;

    /// <summary>Bootstrap, past the title screen, with the feed and the theatre in hand.</summary>
    IEnumerator Rig()
    {
        _boot = new GameObject("Bootstrap");
        _boot.AddComponent<Bootstrap>();
        for (int i = 0; i < 6; i++) yield return null;

        var splash = Object.FindFirstObjectByType<SplashScreen>();
        if (splash != null && splash.Showing) splash.Play();
        yield return null;

        _feed = Object.FindFirstObjectByType<MarketFeed>();
        _theatre = Object.FindFirstObjectByType<StrikeTheatre>();
        Assert.IsNotNull(_feed, "kein MarketFeed");
        Assert.IsNotNull(_theatre, "kein StrikeTheatre");

        // Both skins present, so a wrong side would be visible rather than
        // hidden behind a missing model.
        _theatre.SetBearAirframe(new GameObject("bear-stand-in"));
        _theatre.SetBullAirframe(new GameObject("bull-stand-in"));

        // The socket exists as soon as the source is opened; it does not have
        // to be connected for its queue to be drained.
        for (int i = 0; i < 240 && (_feed.Sources.Count == 0 || _feed.Sources[0].Sock == null); i++)
            yield return null;
        Assert.IsTrue(_feed.Sources.Count > 0 && _feed.Sources[0].Sock != null,
                      "die Binance-Quelle hat keinen Socket");
    }

    /// <summary>
    /// Two orders into the queue, then ONE frame. Both must come out of the
    /// same drain, or the thing being tested never happened.
    /// </summary>
    IEnumerator DrainBoth(string first, string second)
    {
        var v = _feed.Sources[0];
        int before = _feed.Liquidations.Count;
        v.Sock.Deliver(first);
        v.Sock.Deliver(second);
        yield return null;
        Assert.AreEqual(before + 2, _feed.Liquidations.Count,
                        "beide Orders muessen in EINEM Drain durchgehen");
    }

    [UnityTest]
    public IEnumerator TwoOrdersInOneDrainLeaveTheLargerArmedWithItsOwnSkin()
    {
        yield return Rig();
        yield return DrainBoth(Long1M, Short5M);        // smaller first

        Assert.AreEqual(5_000_000, _theatre.PendingUsd, 1.0,
                        "der Latch haelt die groessere");
        Assert.AreEqual(Bear, _theatre.PendingSide, "und deren Seite");

        // now the core consumes: one strike, and the theatre is told
        _theatre.Spent(ArenaCore.StrikeCount + 1);

        Assert.AreEqual(Bear, _theatre.ArmedSide, "der Krater gehoert der 5-Mio-Baer-Order");
        Assert.AreEqual("bear", _theatre.Wearing(_theatre.ArmedSide), "und die Haut auch");
        Assert.AreEqual(0.0, _theatre.PendingUsd, 1.0, "nichts bleibt anstehend");
    }

    [UnityTest]
    public IEnumerator TheOrderInTheDrainDoesNotDecideIt()
    {
        yield return Rig();
        yield return DrainBoth(Short5M, Long1M);        // larger first

        Assert.AreEqual(5_000_000, _theatre.PendingUsd, 1.0, "immer noch die groessere");
        Assert.AreEqual(Bear, _theatre.PendingSide);

        _theatre.Spent(ArenaCore.StrikeCount + 1);

        Assert.AreEqual(Bear, _theatre.ArmedSide);
        Assert.AreEqual("bear", _theatre.Wearing(_theatre.ArmedSide));
        Assert.AreEqual(0.0, _theatre.PendingUsd, 1.0);
    }

    /// <summary>
    /// The side is read off the wire and not invented: a forced SELL is a long
    /// being closed, which is a bull blown out of its position.
    /// </summary>
    [UnityTest]
    public IEnumerator ASingleForcedSellArrivesAsABull()
    {
        yield return Rig();
        var v = _feed.Sources[0];
        v.Sock.Deliver(Long1M);
        yield return null;

        Assert.AreEqual(1_000_000, _theatre.PendingUsd, 1.0);
        Assert.AreEqual(Bull, _theatre.PendingSide, "SELL schliesst einen Long");
        _theatre.Spent(ArenaCore.StrikeCount + 1);
        Assert.AreEqual("bull", _theatre.Wearing(_theatre.ArmedSide));
    }
}
