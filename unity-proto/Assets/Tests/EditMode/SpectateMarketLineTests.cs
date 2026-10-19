// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using UnityEngine;
using NUnit.Framework;

/// <summary>
/// A SPECTATOR IS NOT SHOWN THE MARKET SOCKET'S TELEMETRY (2026-09-18 20:00, photographed: "connecting
/// (error)" in giant green letters across the sky over the mempool).
///
/// `PriceSubline` says "connecting ... (status)" while no price has arrived. Driving, it sits under the price with
/// the HUD's chrome around it and reads as a subline. Spectating there is no price - the headline draws "— — —" -
/// no box and no chrome, so that one line stood alone at 4.5% of the short side across the whole sky.
///
/// So a spectator is shown the market only when there IS one, and then as a corner note in the small style. The
/// socket's own word stays in the debug panel, where `market.Status` already lives.
/// </summary>
public class SpectateMarketLineTests
{
    [Test]
    public void WithNoPriceASpectatorIsShownNothing()
    {
        Assert.IsFalse(DriveHud.MarketLineInSpectate(0.0), "a spectator was shown the market line with no price");
        Assert.IsTrue(DriveHud.MarketLineInSpectate(78515.0), "a spectator with a live price was shown nothing");
    }

    [Test]
    public void TheLineThatWasInTheSkyIsGoneAndNamedInstead()
    {
        // What the photograph showed is no longer drawn anywhere: with no price the subline is empty.
        Assert.AreEqual("", DriveHud.PriceSubline(0.0, 0.0, "error"));
        // What a player is told instead names the feed and what it costs them (2026-09-18 20:04).
        Assert.AreEqual("Bitcoin price feed is down. Chart may be stale.",
            DriveHud.ConnectionTrouble(false, true, false));
        // And with a price it is the day's move, which is what a player reads the market line for.
        Assert.AreEqual("+1.38% 24h", DriveHud.PriceSubline(78515.0, 1.38, "ok"));
    }

    [Test]
    public void ASpectatorsNoteIsSmallerThanTheDrivingHeadline()
    {
        // The note uses the small style; the headline is 13% of the short side and its subline 4.5%. Whatever the
        // screen, a spectator's line must be the small one - that is the difference between a note and a billboard.
        foreach (var (w, h) in new[] { (1280, 800), (1920, 1080), (2560, 1440) })
        {
            int min = System.Math.Min(w, h);
            int headline = Mathf.RoundToInt(min * 0.13f);
            int subline = Mathf.RoundToInt(min * 0.045f);
            int note = DriveHud.SmallFont(w, h);
            Assert.Less(note, subline, $"at {w}x{h} a spectator's note ({note}) is not smaller than the subline ({subline})");
            Assert.Less(note, headline, $"at {w}x{h} a spectator's note ({note}) is not smaller than the headline ({headline})");
        }
    }
}
