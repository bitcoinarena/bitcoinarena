// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using NUnit.Framework;

/// <summary>
/// WHEN THE ROUND TIMER HITS 0 THE GAME ENDS BY ITSELF (2026-09-20 16:21).
///
/// "It used to. It no longer does." The core half is fine and is pinned in JS by round-ends.test.js: a truck
/// braked from the first tick reaches RUN_MISSED at elapsed 10800, because gate.js returns RUN_MISSED once
/// tickInBlock >= BLOCK_TICKS. So the core DOES stop the run on the timer.
///
/// What failed was the client's half, and it was an asymmetry left in SplashScreen earlier the same day: the
/// hold CLOCK was started from `RunHasEnded` - the core's word OR the client's - while the lobby GATE was still
/// handed `ArenaNet.Ended` alone. A round the core had ended with no session word to go with it therefore started
/// its five seconds and then never took them, and the truck sat in a finished world.
///
/// These pin the whole decision, not the halves, because a unit test cannot see a wrong argument at a call site -
/// which is exactly how this got through.
/// </summary>
public class TimerReturnsToLobbyTests
{
    const int RUN_LIVE = 0, RUN_DELIVERED = 1, RUN_WRECKED = 2, RUN_MISSED = 3;
    const float HOLD = 5f;
    static readonly float AFTER = SplashScreen.ResultHoldSeconds;

    /// <summary>The fault itself: the core says MISSED, nothing says it on the wire, and the lobby must still come back.</summary>
    [Test]
    public void TheTimerAloneEndsTheRoundEvenWithNothingOnTheWire()
    {
        Assert.IsTrue(SplashScreen.ShouldReturnToLobby(
                coreAvailable: true, runState: RUN_MISSED, netEnded: false, fromLobby: true,
                wrecked: false, sinceWreck: 0f, hold: HOLD, sinceOutcome: AFTER),
            "the block ran out, the core said MISSED and no session word came with it - the round must still "
            + "hand the screen back, or the truck sits in a finished world");
    }

    /// <summary>Delivered and wrecked come back the same way; the timer is not a special case.</summary>
    [Test]
    public void EveryOutcomeTheCoreNamesComesBack()
    {
        foreach (var word in new[] { RUN_DELIVERED, RUN_MISSED })
            Assert.IsTrue(SplashScreen.ShouldReturnToLobby(true, word, false, true, false, 0f, HOLD, AFTER),
                $"core word {word} must return to the lobby");
        // a wreck waits out the death sequence first, then comes back
        Assert.IsFalse(SplashScreen.ShouldReturnToLobby(true, RUN_WRECKED, false, true, true, 0f, HOLD, AFTER),
            "WASTED is shown before the lobby");
        Assert.IsTrue(SplashScreen.ShouldReturnToLobby(true, RUN_WRECKED, false, true, true, HOLD, HOLD, AFTER),
            "and once the death sequence has had its seconds, the lobby comes back");
    }

    /// <summary>The client's own word still ends a run, so a VOID with no core outcome is unaffected.</summary>
    [Test]
    public void TheClientsWordStillEndsARunOnItsOwn()
    {
        Assert.IsTrue(SplashScreen.ShouldReturnToLobby(true, RUN_LIVE, true, true, false, 0f, HOLD, AFTER),
            "a run the client ended VOID still returns, with the core's word still 0");
        Assert.IsTrue(SplashScreen.ShouldReturnToLobby(false, RUN_LIVE, true, true, false, 0f, HOLD, AFTER),
            "and a page with no core of its own has only the client's word");
    }

    /// <summary>A live round keeps the screen, or the lobby would eat a run in progress.</summary>
    [Test]
    public void ALiveRoundIsNotSentBack()
    {
        Assert.IsFalse(SplashScreen.ShouldReturnToLobby(true, RUN_LIVE, false, true, false, 0f, HOLD, AFTER),
            "a live run must keep the screen");
        Assert.IsFalse(SplashScreen.ShouldReturnToLobby(true, RUN_MISSED, false, fromLobby: false,
                                                        wrecked: false, sinceWreck: 0f, hold: HOLD, sinceOutcome: AFTER),
            "a run that did not come from the lobby has no lobby to go back to");
    }

    /// <summary>And the result is still read first: ending a round does not skip the hold.</summary>
    [Test]
    public void TheResultIsStillHeldBeforeTheLobbyTakesTheScreen()
    {
        Assert.IsFalse(SplashScreen.ShouldReturnToLobby(true, RUN_MISSED, false, true, false, 0f, HOLD, sinceOutcome: 0f),
            "the lobby does not take the screen in the frame the timer ran out");
        Assert.IsTrue(SplashScreen.ShouldReturnToLobby(true, RUN_MISSED, false, true, false, 0f, HOLD, sinceOutcome: AFTER),
            "and it does once the result has been held");
    }
}
