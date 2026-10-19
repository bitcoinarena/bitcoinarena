// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using NUnit.Framework;

/// <summary>
/// A RUN THAT ENDS VOID GIVES THE SCREEN BACK (2026-09-20, the parked ghosts bug).
///
/// MEASURED, two reproductions on Daily 0.0.1812 with two real browser tabs, cache cleared, Network on: zero
/// loadingFailed and zero "Failed to fetch" on either tab across 1151/940 requests. Nothing was refused outright.
/// One tab simply fell about 2000 ticks - 33 s - behind the other, kept playing after its round had closed, and
/// the node ANSWERED and refused those inputs: "the node refuses this run's inputs at tick 8576: error the round
/// is closed - and it still refused after resyncing". The client ended that run VOID.
///
/// The core's word stays 0 through all of that, because the core never reached DELIVERED, WRECKED or MISSED. The
/// return-to-lobby clock was started only by the core's word, or by a page with no core at all, and a VOID is
/// neither - the core is present and silent. So the clock never started, `BackToLobby` never came true, and that
/// tab sat on a dead screen while the other player was already in the lobby choosing round two. Round two then
/// had one invisible truck, because the missing player had never left round one.
///
/// These pin the case that had no clock, and the two that already worked, so the fix cannot be undone quietly.
/// </summary>
public class VoidReturnsToLobbyTests
{
    const int RUN_LIVE = 0, RUN_DELIVERED = 1, RUN_WRECKED = 2, RUN_MISSED = 3;

    /// <summary>The fault itself: core present, core silent, client says the run is over.</summary>
    [Test]
    public void AVoidRunEndsEvenThoughTheCoreNeverNamedAnOutcome()
    {
        Assert.IsTrue(SplashScreen.RunHasEnded(coreAvailable: true, runState: RUN_LIVE, netEnded: true),
            "a run the client ended VOID has ended, even with the core's word still 0 - "
            + "this is the case that left a tab on a dead screen while the other player was in the lobby");
    }

    [Test]
    public void TheCoreNamingAnOutcomeStillEndsTheRun()
    {
        foreach (var word in new[] { RUN_DELIVERED, RUN_WRECKED, RUN_MISSED })
            Assert.IsTrue(SplashScreen.RunHasEnded(true, word, false), $"core word {word} ends the run");
    }

    /// <summary>A page with no core of its own has only the client's word, and that still counts.</summary>
    [Test]
    public void APageWithNoCoreEndsOnTheClientsWord()
    {
        Assert.IsTrue(SplashScreen.RunHasEnded(coreAvailable: false, runState: RUN_LIVE, netEnded: true));
    }

    /// <summary>And a live run is not ended by either route, or the lobby would eat the round.</summary>
    [Test]
    public void ALiveRunHasNotEnded()
    {
        Assert.IsFalse(SplashScreen.RunHasEnded(true, RUN_LIVE, false), "a live run must keep the screen");
        Assert.IsFalse(SplashScreen.RunHasEnded(false, RUN_LIVE, false), "no core and no end is still a live run");
    }

    /// <summary>
    /// The clock alone is not the whole gate: the result still has to be readable first. This keeps the two
    /// rules separate, so ending a run early can never skip the five seconds a player reads the outcome in.
    /// </summary>
    [Test]
    public void EndingTheRunDoesNotSkipTheResultHold()
    {
        Assert.IsFalse(SplashScreen.BackToLobby(true, true, false, 0f, 5f, sinceOutcome: 0f),
            "the lobby does not take the screen in the frame the run ended");
        Assert.IsTrue(SplashScreen.BackToLobby(true, true, false, 0f, 5f, sinceOutcome: SplashScreen.ResultHoldSeconds),
            "and it does once the result has been held");
    }
}
