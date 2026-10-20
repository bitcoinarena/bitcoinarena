// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using NUnit.Framework;
using Arena;

/// <summary>
/// THE LOBBY'S LINES ON A PHONE (measured on UI 133 at 390 px: the header cut to "ROUNDS · JOIN NEEDS 5 OF 7 SIGNER NC"
/// and the round row to "... · join until 1:00 · 7 signer node"): the header and each row offer shorter wordings after the full
/// one, the drawer takes the longest that fits, and the full one stays first so a wide screen reads exactly as before.
/// </summary>
public class LobbyPhoneWordsTests
{
    static LobbyRow Paid(int agree = 7, int needed = 5, int total = 7, bool joinable = true, int leftS = 60) =>
        new LobbyRow { id = "c71ee776bb", free = false, stakeSats = 100, agree = agree, needed = needed, total = total, joinable = joinable, startS = 28, leftS = leftS };

    [Test]
    public void TheHeader_FullFirst_ThenTheSameNumbersInFewerWords_ThenRounds()
    {
        var w = DailyLobby.HeaderWordings(new[] { Paid(), Paid() });
        CollectionAssert.AreEqual(new[] { "ROUNDS · JOIN NEEDS 5 OF 7 SIGNER NODES", "ROUNDS · 5 OF 7 SIGNER NODES", "ROUNDS · 5 OF 7 NODES", "ROUNDS" }, w);
        Assert.AreEqual(DailyLobby.HeaderWords(new[] { Paid() }), DailyLobby.HeaderWordings(new[] { Paid() })[0], "the wide screen reads as before");
        CollectionAssert.AreEqual(new[] { "ROUNDS" }, DailyLobby.HeaderWordings(new LobbyRow[0]));
    }

    [Test]
    public void ARow_KeepsItsWordings_ThenTheNodesAsACount_ThenTheTimesAlone()
    {
        var w = DailyLobby.RowWords(Paid());
        Assert.AreEqual("PAID · 100 sats · starts in 0:28 · join until 1:00 · 7 signer nodes (5 needed)", w[2], "the third wording is unchanged");
        Assert.AreEqual("PAID · 100 sats · starts in 0:28 · join until 1:00 · 7 nodes", w[3]);
        Assert.AreEqual("PAID · 100 sats · starts in 0:28 · join until 1:00", w[4]);
        Assert.AreEqual("PAID · 100 sats · starts in 0:28 · join until 0:00 · entry closed", DailyLobby.RowWords(Paid(joinable: false, leftS: 0))[3]);
        Assert.AreEqual("PAID · 100 sats · starts in 0:28 · join until 1:00 · 1 node", DailyLobby.RowWords(Paid(agree: 1))[3]);
    }

    [Test]
    public void TheLineUnderTheRows_FullFirst_ThenFewerWords_ThenTheRoundAlone()
    {
        var w = DailyLobby.HintWordings(Paid(agree: 6), 1);
        Assert.AreEqual(DailyLobby.HintWords(Paid(agree: 6), 1), w[0], "the wide screen reads as before");
        Assert.AreEqual("PLAY joins round c71ee776 - 6 signer nodes agree (5 needed)", w[0]);
        Assert.AreEqual("PLAY joins c71ee776 - 6 agree (5 needed)", w[1]);
        Assert.AreEqual("PLAY joins round c71ee776", w[2]);
        CollectionAssert.AreEqual(new[] { "PLAY waits for an open round", "PLAY waits for a round" }, DailyLobby.HintWordings(null, 0));
    }
}
