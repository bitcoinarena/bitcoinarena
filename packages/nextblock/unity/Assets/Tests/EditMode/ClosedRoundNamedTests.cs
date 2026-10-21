// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using NUnit.Framework;
using Arena;

/// <summary>
/// A CLOSED ROUND IS NOT A CHOICE (2026-09-26 16:56, phone, build 0.0.2109): "Not joined: the node refused the entry:
/// the round is closed" lay on a row reading "PAID · 100 sats · closes 1:11 · 2 of 2 signer nodes" - the next paid round,
/// worded exactly as the closed one had been - and the same sentence stood again under the card. Measured live: PLAY on paid
/// round ad044188 after it closed, the next paid round 5a7bbb44 listed, nothing on screen told the two apart. The refusal now
/// names its round as the lobby names it, and every row names its own while it is up.
/// </summary>
public class ClosedRoundNamedTests
{
    const string Closed = "ad044188796bd9d20412d10f140fb6edd9ef3328b8ac378e614c27390e9a7a4d";
    const string Json = "{\"mode\":\"lobby\",\"rows\":[{\"id\":\"5a7bbb44aa\",\"line\":\"x\",\"free\":false,\"agree\":2,\"needed\":2,"
        + "\"joinable\":true,\"leftS\":71,\"joined\":0,\"stakeSats\":100}],\"nodes\":2,\"join\":{\"state\":\"refused\","
        + "\"why\":\"the node refused the entry: the round is closed\",\"stage\":\"\",\"round\":\"" + Closed + "\",\"kindKnown\":true,"
        + "\"free\":false,\"stakeSats\":100}}";

    [Test]
    public void TheRefusalNamesTheClosedRoundByItsLobbyName()
    {
        var s = DailyLobby.Parse(Json);
        Assert.AreEqual(Closed, s.join.round);
        Assert.AreEqual("Not joined: PAID · 100 sats round ad044188 is closed - the node refused its entry.",
            DailyLobby.LobbyError(s, s.join.why));
        StringAssert.DoesNotContain("the round is closed", DailyLobby.LobbyError(s, s.join.why), "not \"the round\"");
    }

    [Test]
    public void WhileARefusalNamesARound_EveryRowSaysItsOwnName()
    {
        var s = DailyLobby.Parse(Json);
        foreach (var w in DailyLobby.RowWords(s.rows[0], true)) StringAssert.StartsWith("PAID · 100 sats · round 5a7bbb44 · join until 1:11", w);
        foreach (var w in DailyLobby.RowWords(s.rows[0])) StringAssert.DoesNotContain("round ", w, "without a refusal the row reads as before");
    }

    [Test]
    public void AnOlderPageOrAnotherReason_StillReads()
    {
        Assert.AreEqual("Not joined: the node refused the entry: the round is closed.",
            DailyLobby.LobbyError(DailyLobby.Parse("{\"mode\":\"lobby\"}"), "the node refused the entry: the round is closed"),
            "a page that names no round: the reason as it came");
        var s = DailyLobby.Parse("{\"mode\":\"lobby\",\"join\":{\"state\":\"refused\",\"why\":\"no such round\",\"round\":\"" + Closed + "\"}}");
        Assert.AreEqual("Not joined round ad044188: no such round.", DailyLobby.LobbyError(s, "no such round"), "kind unknown: the id alone");
    }
}
