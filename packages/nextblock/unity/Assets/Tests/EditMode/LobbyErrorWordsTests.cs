// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using NUnit.Framework;
using Arena;

/// <summary>
/// THE LOBBY SAYS WHY (MF 18 on 0.0.2520): with every seat unreachable it read "No round is open for entry right now",
/// and a round link whose committee had not formed left the lobby silent. Now: none reached is said so, with how many were asked,
/// and a round not open yet says when it opens.
/// </summary>
public class LobbyErrorWordsTests
{
    [Test]
    public void EverySeatFailed_SaysNoneAnswered_WithHowManyWereAsked()
    {
        var s = new LobbyState { asked = 14, failed = 14, refused = new[] { "a", "b" } };
        Assert.AreEqual("No signer node answered (14 asked) - the rounds cannot be read. Asked again every 5 seconds.", DailyLobby.EmptyListLine(s));
    }

    [Test]
    public void SomeSeatsAnswered_NoRoundOpen_SaysSoAsBefore()
    {
        var s = new LobbyState { asked = 14, failed = 3, refused = new string[0] };
        Assert.AreEqual("No round is open for entry right now. The signer nodes are asked again every 5 seconds.", DailyLobby.EmptyListLine(s));
        var old = new LobbyState { refused = new[] { "x" } };   // an older page that sends no counts reads as before
        StringAssert.StartsWith("No round is open for entry right now.", DailyLobby.EmptyListLine(old));
        StringAssert.EndsWith("Not listed: 1", DailyLobby.EmptyListLine(old));
    }

    [Test]
    public void ARoundNotOpenYet_TheRedBoxSaysWhenItOpens()
    {
        var join = new LobbyJoin { round = "1234abcd99", kindKnown = false };
        Assert.AreEqual("Round 1234abcd opens for entry at 06:00 UTC - PLAY it then",
            DailyLobby.RefusedLine(join, "Round 1234abcd opens for entry at 06:00 UTC - PLAY it then"));
        Assert.AreEqual("Not joined round 1234abcd: the deposit was closed.", DailyLobby.RefusedLine(join, "the deposit was closed"), "other refusals as before");
    }
}

/// <summary>
/// A ROUND LINK HELD TO ITS START DOES NOT DRIVE (measured on preview UI 137: a reload during a held join came up driving
/// 29 s before the start, with no stake): the address's play=1 waits for the page's word, "no" when held, and drives on any other word.
/// </summary>
public class LinkAutoPlayTests
{
    [Test]
    public void HeldNeverDrives_UndecidedWaits_ThenDrives_AnOlderPageDrivesAsBefore()
    {
        Assert.AreEqual("no", DailyLobby.LinkAutoPlayStep(0, 0f));
        Assert.AreEqual("no", DailyLobby.LinkAutoPlayStep(0, 100f), "held stays held, however long");
        Assert.AreEqual("wait", DailyLobby.LinkAutoPlayStep(-1, 0f));
        Assert.AreEqual("wait", DailyLobby.LinkAutoPlayStep(-1, DailyLobby.LinkWaitS - 0.01f));
        Assert.AreEqual("play", DailyLobby.LinkAutoPlayStep(-1, DailyLobby.LinkWaitS), "no word in time: as before");
        Assert.AreEqual("play", DailyLobby.LinkAutoPlayStep(1, 0f));
        Assert.AreEqual("play", DailyLobby.LinkAutoPlayStep(2, 0f), "an older page that says nothing");
    }
}
