// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.IO;
using NUnit.Framework;
using UnityEngine;

/// <summary>
/// THE NEXT ROUND IS PLAYED, NOT THE LOBBY (2026-09-30 09:39, item 2: "After the countdown the lobby comes back and the
/// player must join by hand. Wrong. The next round starts by itself. The player is already joined"). At the next round's
/// start the page flips its join to "joined" and `continuing` off in one repaint; a poll that read both at once left the
/// adopted join unstepped, and the last run's ended word brought the lobby back and dropped the join.
/// </summary>
public class NextRoundPlaysTests
{
    [Test]
    public void AnAdoptedJoinIsFollowedAfterContinuingEnds()
    {
        Assert.IsTrue(SplashScreen.FollowsThePage(continuing: true, nextJoinGoing: false), "the countdown is followed");
        Assert.IsTrue(SplashScreen.FollowsThePage(continuing: false, nextJoinGoing: true),
            "at the next round's start, continuing off, the adopted join was not followed - the 09:39 lobby");
        Assert.IsFalse(SplashScreen.FollowsThePage(continuing: false, nextJoinGoing: false));
    }

    [Test]
    public void TheLastRunsEndDoesNotBringTheLobbyWhileTheNextRoundIsJoined()
    {
        Assert.IsFalse(SplashScreen.MayReturnToLobby(continuing: false, nextJoinGoing: true),
            "the lobby came back over a next round being joined");
        Assert.IsFalse(SplashScreen.MayReturnToLobby(continuing: true, nextJoinGoing: false));
        Assert.IsTrue(SplashScreen.MayReturnToLobby(continuing: false, nextJoinGoing: false),
            "with no next round (exit game, refused) the lobby must still come back");
    }

    [Test]
    public void TheRaceFrameStepsTheJoinAndDoesNotShowTheLobby()
    {
        // The frame measured: continuing already off, the page's join "joined", the last run ended with its hold spent.
        bool nextJoin = true, continuing = false;
        bool ended = SplashScreen.ShouldReturnToLobby(coreAvailable: true, runState: 1, netEnded: true, fromLobby: true,
            wrecked: false, sinceWreck: 0f, hold: 5f, sinceOutcome: 60f);
        Assert.IsTrue(ended, "precondition: without the next join, this frame is the lobby's");
        Assert.IsFalse(SplashScreen.MayReturnToLobby(continuing, nextJoin) && ended, "this frame showed the lobby");
        var page = new Arena.LobbyState { join = new Arena.LobbyJoin { state = "joined", round = "r1", next = true } };
        Assert.AreEqual("play", Arena.DailyLobby.AfterJoin(page, sessionRunning: true, joinedForS: 0f),
            "a joined next round with its session up is played");
    }

    [Test]
    public void UpdateReadsStepsAndGuardsWithTheNextJoin()
    {
        string src = File.ReadAllText(Path.Combine(Application.dataPath, "Scripts/SplashScreen.cs"));
        StringAssert.Contains("if (FollowsThePage(Continuing, _nextJoin) && page != null) _lobby = page;", src,
            "the page is read only while continuing");
        StringAssert.Contains("if (!Showing && FollowsThePage(Continuing, _nextJoin)) { AdoptNextJoin(); if (StepJoin()) return; }", src,
            "the adopted join is stepped only while continuing");
        StringAssert.Contains("if (!Showing && MayReturnToLobby(Continuing, _nextJoin) && LobbyMayCover(cardUp) && ShouldReturnToLobby(", src,
            "the last run's end can bring the lobby over the next round's join");
        StringAssert.Contains("_joining = true; _nextJoin = true;", src, "adopting a next round does not mark it");
    }
}
