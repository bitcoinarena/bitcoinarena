// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using NUnit.Framework;
using Arena;

/// <summary>
/// THE LOBBY SHOWS UP, AND A LOBBY WITH NO ROUNDS IS NOT MISTAKEN FOR ONE (2026-09-20).
///
/// WHY THIS EXISTS, and it is worth writing down because it cost a wrong bug report: on the morning the combined
/// cover deploy shipped, a headless Chrome parked on the Daily since before the deploy was screenshotted without
/// its cache being cleared. It could not reach the signer doors, so the lobby came up with NO ROUNDS - no
/// identity line, no FREE row, no PAID row, just the how-to text and PLAY/SPECTATE - and that was reported as a
/// regression that had eaten the infographics. Nothing had regressed. The page was fine; the view was stale and
/// node-less. `Network.clearBrowserCache` and the same build produced the whole lobby.
///
/// So the fault this guards is not "the lobby is gone". It is that a lobby with no rounds LOOKS like a lobby, and
/// nothing said which one was on screen. These tests pin both shapes apart, from the payload the live Daily
/// actually returns rather than an invented one.
///
/// The sample below is `window.ARENA_LOBBY_VIEW()` read off btc-logistics-core.pages.dev at build 0.0.1812 over
/// CDP, with the two round ids and the tunnel hostnames left exactly as they came.
/// </summary>
public class LobbyShowsUpTests
{
    /// <summary>The live Daily's own lobby payload, one FREE and one PAID round, both 2-of-2 agreed.</summary>
    const string Live =
        "{\"mode\":\"lobby\",\"from\":\"daily.json\",\"you\":{\"name\":\"late-moose-6926\",\"custom\":false,"
        + "\"generated\":\"late-moose-6926\",\"fingerprint\":\"dfcb-4808-cdee-b555\"},\"rows\":["
        + "{\"id\":\"ad00a903dffb2ecf7216ba958f47b0b579154b377570884cc217cf70bd992fff\","
        + "\"line\":\"free - no wallet, no Lightning · entry open, closes in 1:11 · 2 of 2 signer nodes agree\","
        + "\"free\":true,\"agree\":2,\"needed\":2,\"joinable\":true,\"leftS\":71,\"joined\":0,\"stakeSats\":0},"
        + "{\"id\":\"38b2038040a8dbd8ca5f46681016fdb8e0c9975396377c2a82d358c52e457523\","
        + "\"line\":\"stake 100 sat - a Lightning payment · entry open, closes in 1:26 · 2 of 2 signer nodes agree\","
        + "\"free\":false,\"agree\":2,\"needed\":2,\"joinable\":true,\"leftS\":86,\"joined\":0,\"stakeSats\":100}],"
        + "\"refused\":[],\"nodes\":2,\"unanswered\":[],\"answerS\":10,"
        + "\"join\":{\"state\":\"\",\"why\":\"\",\"stage\":\"\"},"
        + "\"withdraw\":{\"available\":false,\"msat\":\"0\",\"elsewhere\":false}}";

    [Test]
    public void TheLiveDailyPayloadComesUpAsAWholeLobby()
    {
        var s = DailyLobby.Parse(Live);
        Assert.IsNotNull(s, "the payload the live Daily returns must come up as a lobby");
        Assert.AreEqual("daily.json", s.from, "the lobby is built from the deployed daily.json");

        // the identity line the player reads at the top
        Assert.AreEqual("late-moose-6926", s.you.name);
        Assert.IsNotEmpty(s.you.fingerprint, "the lobby shows the key it made the name from");

        // the rounds - the half that was missing on the stale view
        Assert.AreEqual(2, s.rows.Length, "one FREE and one PAID round were listed");
        Assert.AreEqual(2, s.nodes, "both signer nodes answered");
        Assert.IsEmpty(s.unanswered, "no signer node was silent");
        Assert.IsEmpty(s.refused, "no round was refused");

        var free = System.Array.Find(s.rows, r => r.free);
        var paid = System.Array.Find(s.rows, r => !r.free);
        Assert.IsNotNull(free, "a FREE round was listed");
        Assert.IsNotNull(paid, "a PAID round was listed");
        foreach (var r in s.rows)
        {
            Assert.AreEqual(2, r.agree, "a listed round has both signer nodes agreeing");
            Assert.AreEqual(2, r.needed, "the Daily is 2-of-2");
            Assert.IsTrue(r.joinable, "an open round with both nodes agreeing is joinable");
            Assert.Greater(r.leftS, 0, "a listed round still has entry time left");
        }

        // and PLAY lands on the free one, so a player with no sats is never dropped onto a stake
        int pick = DailyLobby.PickDefault(s.rows);
        Assert.AreNotEqual(-1, pick, "PLAY has a round to join");
        Assert.IsTrue(s.rows[pick].free, "PLAY joins the FREE round");
    }

    /// <summary>
    /// THE SHAPE THAT WAS MISREAD. A page that reached no signer node still parses as a lobby - that is correct,
    /// the player must get a screen - but it is an EMPTY one, and these are the fields that say so. If a future
    /// screenshot shows the how-to and no rounds, this is the state to check rather than the deploy.
    /// </summary>
    [Test]
    public void ALobbyThatReachedNoSignerNodeIsEmptyAndSaysSo()
    {
        const string noNodes = "{\"mode\":\"lobby\",\"from\":\"daily.json\",\"rows\":[],\"refused\":[],"
            + "\"nodes\":0,\"unanswered\":[\"https://a.example\",\"https://b.example\"],\"answerS\":10}";
        var s = DailyLobby.Parse(noNodes);
        Assert.IsNotNull(s, "the player still gets a lobby screen when the nodes are silent");
        Assert.IsEmpty(s.rows, "with no signer node answering there is nothing to join");
        Assert.AreEqual(0, s.nodes);
        Assert.AreEqual(2, s.unanswered.Length, "the silent signer nodes are named");
        Assert.AreEqual(-1, DailyLobby.PickDefault(s.rows), "PLAY has no round to join");
        Assert.IsNotEmpty(DailyLobby.UnansweredLine(s), "the lobby tells the player a signer node did not answer");
    }

    /// <summary>
    /// A round listed without both signer nodes is never what PLAY joins, however much time it has left. The live
    /// Daily is 2-of-2 and a join needs both; this keeps that true when only one node is answering.
    /// </summary>
    [Test]
    public void ARoundOneSignerNodeShortIsNeverWhatPlayJoins()
    {
        var rows = new[]
        {
            new LobbyRow { id = "onenode", free = true, agree = 1, needed = 2, joinable = false, leftS = 900 },
            new LobbyRow { id = "bothnodes", free = true, agree = 2, needed = 2, joinable = true, leftS = 60 },
        };
        int pick = DailyLobby.PickDefault(rows);
        Assert.AreNotEqual(-1, pick, "the 2-of-2 round is joinable");
        Assert.AreEqual("bothnodes", rows[pick].id, "PLAY never joins a round one signer node short");
    }

    /// <summary>
    /// The four how-to panels are the lobby's own artwork, cut from one sheet. The whole sheet has to be in
    /// Resources at its authored size or the lobby draws the steps with nothing above them - which is exactly
    /// what the stale, node-less view looked like.
    /// </summary>
    [Test]
    public void TheLobbyKeepsItsHowToArt()
    {
        var t = UnityEngine.Resources.Load<UnityEngine.Texture2D>(DailyLobby.HowToWhole);
        Assert.IsNotNull(t, "the lobby's how-to art is not in Resources");
        Assert.Greater(t.width, 0);
        Assert.Greater(t.height, 0);
    }
}
