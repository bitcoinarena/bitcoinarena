// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using NUnit.Framework;
using Arena;

/// <summary>
/// NEVER HANG FOREVER, THE LOBBY'S HALF (2026-09-17). Measured before on the Daily with its tunnels silent: a round past its
/// close offered with PLAY enabled for 237 s, then an empty list and a grey PLAY with no message; the only error text was the
/// small grey hint after a refused join. The page now gives each signer node 10 s and names the ones that did not answer;
/// these are the words the lobby draws from that, in red on the list.
/// </summary>
public class LobbySilentSignerTests
{
    const string Json = "{\"mode\":\"lobby\",\"rows\":[{\"id\":\"4ef3c05c830639bb\",\"line\":\"x\",\"free\":true,\"agree\":1,\"needed\":2,"
        + "\"joinable\":false,\"leftS\":93,\"joined\":0,\"stakeSats\":0}],\"refused\":[\"https://tramadol-sent-commander-arrived.trycloudflare.com: did not answer in 10 s\"],"
        + "\"unanswered\":[\"https://tramadol-sent-commander-arrived.trycloudflare.com\"],\"answerS\":10,\"nodes\":2}";

    [Test]
    public void ASilentSignerNodeIsNamedWithItsLimit()
    {
        var s = DailyLobby.Parse(Json);
        Assert.IsNotNull(s);
        Assert.AreEqual(1, s.unanswered.Length);
        Assert.AreEqual("Signer node tramadol-sent-commander-arrived.trycloudflare.com did not answer in 10 s. "
            + "PLAY waits until every signer node of the round answers - asked again every second.", DailyLobby.UnansweredLine(s));
        Assert.AreEqual(-1, DailyLobby.PickDefault(s.rows), "PLAY has nothing to join while one of 2 is silent");
    }

    [Test]
    public void TwoSilentNodesAreBothNamed_AndNoneSaysNothing()
    {
        var s = DailyLobby.Parse("{\"mode\":\"lobby\",\"unanswered\":[\"http://127.0.0.1:18190\",\"http://127.0.0.1:18191/\"],\"answerS\":10}");
        StringAssert.StartsWith("Signer nodes 127.0.0.1:18190 and 127.0.0.1:18191 did not answer in 10 s.", DailyLobby.UnansweredLine(s));
        Assert.AreEqual("", DailyLobby.UnansweredLine(DailyLobby.Parse("{\"mode\":\"lobby\"}")), "an older page that sends no list: nothing to say");
        Assert.AreEqual("", DailyLobby.UnansweredLine(DailyLobby.Parse("{\"mode\":\"lobby\",\"unanswered\":[]}")));
    }

    [Test]
    public void ARefusedJoinLeadsTheRedBox()
    {
        var s = DailyLobby.Parse(Json);
        string said = DailyLobby.LobbyError(s, "signer nodes a.example and b.example did not answer in 30 s");
        StringAssert.StartsWith("Not joined: signer nodes a.example and b.example did not answer in 30 s.\n", said);
        StringAssert.Contains("did not answer in 10 s", said);
        Assert.AreEqual(DailyLobby.UnansweredLine(s), DailyLobby.LobbyError(s, ""));
    }

    [Test]
    public void AClosedRoundSaysEntryClosedNotWaiting()
    {
        var closed = new LobbyRow { id = "4ef3c05c830639bb", free = true, agree = 2, needed = 2, joinable = false, leftS = 0 };
        StringAssert.Contains("2 signer nodes (2 needed) - entry closed", DailyLobby.RowWords(closed)[0]);
        var waiting = new LobbyRow { id = "4ef3c05c830639bb", free = true, agree = 1, needed = 2, joinable = false, leftS = 40 };
        StringAssert.Contains("1 signer node (2 needed) - waiting", DailyLobby.RowWords(waiting)[0]);
    }
}
