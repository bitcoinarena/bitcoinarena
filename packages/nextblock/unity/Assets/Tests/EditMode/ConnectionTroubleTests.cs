// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using NUnit.Framework;

/// <summary>
/// A BROKEN CONNECTION IS NAMED IN WORDS A PLAYER CAN ACT ON (2026-09-18 20:04).
///
/// Photographed at 20:00: "connecting … (error)" across the sky over the mempool - the market socket's own
/// vocabulary, saying nothing about which connection had failed or what it cost the player. Each line here names the
/// thing and what will be seen to go wrong, and a connection that comes back takes its line with it.
/// </summary>
public class ConnectionTroubleTests
{
    [Test]
    public void EachBrokenConnectionNamesItselfAndWhatItCosts()
    {
        Assert.AreEqual("Bitcoin price feed is down. Chart may be stale.",
            DriveHud.ConnectionTrouble(false, true, false));
        Assert.AreEqual("Lost the round feed. Other trucks may freeze.",
            DriveHud.ConnectionTrouble(true, false, false));
        Assert.AreEqual("Spectate lost the live feed.",
            DriveHud.ConnectionTrouble(true, false, true));
    }

    [Test]
    public void ARecoveredConnectionLeavesNothingBehind()
    {
        Assert.AreEqual("", DriveHud.ConnectionTrouble(true, true, false), "a line was left standing with nothing wrong");
        Assert.AreEqual("", DriveHud.ConnectionTrouble(true, true, true), "a spectator was told of a fault that had gone");
    }

    [Test]
    public void TheRoundFeedIsTheOneTheOtherTrucksArriveOn()
    {
        // A live session whose socket is down is the fault; a finished run is not, and neither is having no session.
        Assert.IsFalse(DriveHud.RoundFeedOk(sessionLive: true, runEnded: false, socketDown: true));
        Assert.IsTrue(DriveHud.RoundFeedOk(sessionLive: true, runEnded: true, socketDown: true),
            "a player who finished was told the round feed is lost");
        Assert.IsTrue(DriveHud.RoundFeedOk(sessionLive: false, runEnded: false, socketDown: true),
            "a page with no session was told the round feed is lost");
        Assert.IsTrue(DriveHud.RoundFeedOk(sessionLive: true, runEnded: false, socketDown: false));
    }

    [Test]
    public void ThePriceFeedIsWellOnlyWithAPriceAndNoError()
    {
        Assert.IsFalse(DriveHud.PriceFeedOk(0.0, "error"), "the photographed case was called well");
        Assert.IsFalse(DriveHud.PriceFeedOk(0.0, "connecting"));
        Assert.IsFalse(DriveHud.PriceFeedOk(78515.0, "error"));
        Assert.IsTrue(DriveHud.PriceFeedOk(78515.0, "ok"));
    }

    [Test]
    public void TheSublineNoLongerCarriesTheSocketsWord()
    {
        // It said "connecting … (error)" under a headline of dashes; the sentence above says it instead, in the
        // corner, and the subline is simply empty until there is a day to show.
        Assert.AreEqual("", DriveHud.PriceSubline(0.0, 0.0, "error"));
        Assert.AreEqual("+1.38% 24h", DriveHud.PriceSubline(78515.0, 1.38, "ok"));
    }
}
