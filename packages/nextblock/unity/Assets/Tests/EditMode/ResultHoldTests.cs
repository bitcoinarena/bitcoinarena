// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using NUnit.Framework;

/// <summary>
/// A RESULT IS READ BEFORE THE LOBBY TAKES THE SCREEN (2026-09-18 19:30: "lobby comes back too fast when the
/// truck reaches the goal - the player cannot read the result. Hold the result at least 5 seconds before the lobby").
///
/// A run ends in the tick the core says DELIVERED and the page hands that word over in the same frame, so the lobby
/// came up on top of the outcome. The wreck already had this rule from the 17:00 report - WASTED first, then the
/// lobby - and a delivery is the same thing from the other end. `FINISH_WAIT_MS` is not this: 300 ms is how long the
/// last ticks have to reach the wire, a network drain that was never a screen.
/// </summary>
public class ResultHoldTests
{
    const float Wreck = 5f;      // TruckHealth.respawnSeconds in the scene this ships

    [Test]
    public void ADeliveredRunHoldsItsResultBeforeTheLobby()
    {
        // The frame the run ends in: nothing yet.
        Assert.IsFalse(SplashScreen.BackToLobby(true, true, false, 0f, Wreck, 0f),
            "the lobby came back in the frame the run ended");
        Assert.IsFalse(SplashScreen.BackToLobby(true, true, false, 0f, Wreck, 4.9f),
            "the lobby came back before the result had five seconds");
        Assert.IsTrue(SplashScreen.BackToLobby(true, true, false, 0f, Wreck, SplashScreen.ResultHoldSeconds),
            "the lobby never comes back after the result has been shown");
        Assert.GreaterOrEqual(SplashScreen.ResultHoldSeconds, 5f, "the result is held for less than five seconds");
    }

    [Test]
    public void AWreckStillWaitsForItsOwnBurnAsWell()
    {
        // The 17:00 rule stands: a wreck waits for the death sequence, and now also for the result's own five seconds.
        Assert.IsFalse(SplashScreen.BackToLobby(true, true, true, 1f, Wreck, 9f),
            "a wreck went back to the lobby before its burn had finished");
        Assert.IsTrue(SplashScreen.BackToLobby(true, true, true, Wreck, Wreck, SplashScreen.ResultHoldSeconds),
            "a wreck never goes back to the lobby");
    }

    [Test]
    public void ARunThatIsStillLiveNeverGoesBack()
    {
        Assert.IsFalse(SplashScreen.BackToLobby(false, true, false, 0f, Wreck, 60f),
            "a live run was sent back to the lobby");
        Assert.IsFalse(SplashScreen.BackToLobby(true, false, false, 0f, Wreck, 60f),
            "a run that did not start from the lobby was sent back to it");
    }

    // THE LOBBY IS NOT DRAWN OVER THE RESULT CARD (2026-09-25): coverage, not the clock.
    [Test]
    public void TheLobbyNeverCoversTheResultCard()
    {
        Assert.IsFalse(SplashScreen.LobbyMayCover(resultCardUp: true), "the lobby may be drawn while the result card is up");
        Assert.IsTrue(SplashScreen.LobbyMayCover(resultCardUp: false), "the lobby never comes back once the card is down");
    }

    [Test]
    public void TheLobbyAsksTheCardBeforeItComesBackAndBeforeItDraws()
    {
        string src = System.IO.File.ReadAllText(System.IO.Path.Combine(UnityEngine.Application.dataPath, "Scripts/SplashScreen.cs"));
        int back = src.IndexOf("LobbyMayCover(cardUp) && ShouldReturnToLobby(");
        Assert.GreaterOrEqual(back, 0, "the lobby's return after a run does not wait for the result card");
        int gui = src.IndexOf("void OnGUI()");
        int gate = src.IndexOf("if (!LobbyMayCover(_hud != null && _hud.ArrivalShowing)) return;", gui);
        int depth = src.IndexOf("GUI.depth = -200", gui);
        Assert.IsTrue(gui >= 0 && gate > gui && gate < depth, "OnGUI draws the lobby before asking whether the result card is up");
    }

    // THE RESULT SCREEN HOLDS 8 s (2026-09-25 21:53: "stays up 3 seconds longer. It holds 5 s now ... Make that 8 s").
    [Test]
    public void TheResultCardAndTheLobbysHoldAreEightSeconds()
    {
        Assert.AreEqual(8f, DriveHud.ArrivalHoldSeconds);
        Assert.AreEqual(DriveHud.ArrivalHoldSeconds, SplashScreen.ResultHoldSeconds, "the card and the lobby on two clocks again");
        Assert.IsFalse(SplashScreen.BackToLobby(true, true, false, 0f, 5f, 7.9f), "the lobby came back before the card's 8 s");
    }
}
