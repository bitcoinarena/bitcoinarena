// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using NUnit.Framework;

/// <summary>
/// THE RESULT SUMMARY'S WORDS (2026-10-04): the four lines on the end card, from the round result the page read -
/// names by outcome, the top-3 high score in the lobby's units, this player's result and net, and the preliminary balance
/// list headed by how many runs five signers signed. Nothing is worked out here that the seats did not say.
/// </summary>
public class ResultSummaryTests
{
    const string Mine = "6b06da901d10a2f0f5806d5ec88c53229803b8e294910bcd332fb1d307dab094";

    // round 572adcf6 as the seats answered at 22:15Z, projected by index.html (settlement not accepted yet: pending)
    const string OneRun = "{\"mine\":\"" + Mine + "\",\"players\":[{\"entry\":\"" + Mine + "\",\"key\":\"f608dffc6f98145e1d793717c160eae70c616ae2513c9910099c34fbf1fce8d2\","
        + "\"name\":\"\",\"outcome\":\"DELIVERED\",\"score\":8304450,\"signedBy\":7,\"result\":\"pending\",\"net\":\"\",\"stakeMsat\":\"100000\"}]}";

    [Test]
    public void OneDeliveredRunStillPendingReadsAsTheSeatsSaidIt()
    {
        var lines = ResultSummary.Lines(ResultSummary.Parse(OneRun));
        Assert.AreEqual(new[] {
            "DELIVERED you",
            "HIGH SCORE  1. you 83.04450",
            "YOU  DELIVERED  ·  pending",
            "preliminary · 1 of 1 runs signed",
            "you  stake 100 sat  ·  pending",
        }, lines.ToArray());
    }

    [Test]
    public void FourPlayersNamesByOutcomeTopThreeScoresSignedCountAndAndNMore()
    {
        string P(string entry, string key, string name, string outcome, long score, int signed, string result, string net) =>
            $"{{\"entry\":\"{entry}\",\"key\":\"{key}\",\"name\":\"{name}\",\"outcome\":\"{outcome}\",\"score\":{score},\"signedBy\":{signed},\"result\":\"{result}\",\"net\":\"{net}\"}}";
        string json = "{\"mine\":\"e1\",\"players\":["
            + P("e1", "aaaaaaaaaaaa", "", "DELIVERED", 8304450, 7, "won", "12500") + ","
            + P("e2", "bbbbbbbbbbbb", "J\\u00fcrgen", "FAILED", 4147753, 6, "lost", "-100000") + ","
            + P("e3", "cccccccccccc", "", "DELIVERED", 16147950, 4, "stake back", "-4000") + ","
            + P("e4", "dddddddddddd", "", "", -1, 0, "", "") + "]}";
        var w = ResultSummary.Parse(json);
        var all = ResultSummary.Lines(w);
        Assert.AreEqual("DELIVERED you, cccccccc  ·  FAILED Jürgen  ·  1 still driving", all[0], "a FAILED player is named, by the signed word");
        Assert.AreEqual("HIGH SCORE  1. cccccccc 161.47950   2. you 83.04450", all[1], "a FAILED run's signed score is no high score");
        Assert.AreEqual("YOU  DELIVERED  ·  WON  +12.5 sat", all[2]);
        Assert.AreEqual("preliminary · 2 of 4 runs signed", all[3], "signed means five signers or more");
        Assert.AreEqual(new[] { "you  +12.5 sat", "Jürgen  -100 sat", "cccccccc  -4 sat", "dddddddd  pending" }, all.GetRange(4, 4).ToArray());
        var cut = ResultSummary.Lines(w, 3);
        Assert.AreEqual(8, cut.Count);
        Assert.AreEqual("and 1 more", cut[7]);
    }

    [Test]
    public void NothingReadYetDrawsNothing()
    {
        Assert.IsNull(ResultSummary.Parse(null));
        Assert.IsNull(ResultSummary.Parse(""));
        Assert.AreEqual(0, ResultSummary.Lines(null).Count);
        Assert.AreEqual("pending", ResultSummary.Sats(""));
        Assert.AreEqual("+0 sat", ResultSummary.Sats("0"));
        Assert.AreEqual("-1.5 sat", ResultSummary.Sats("-1500"));
        Assert.AreEqual("0.00001", ResultSummary.Score(1));
    }

    // THE CARD WAITS FOR THE SIGNED RESULT (2026-10-04, option 1): the page's hold rides with the summary
    [Test]
    public void ThePagesHoldIsRead()
    {
        Assert.IsTrue(ResultSummary.Parse("{\"mine\":\"e1\",\"hold\":true,\"players\":[]}").hold);
        Assert.IsFalse(ResultSummary.Parse("{\"mine\":\"e1\",\"hold\":false,\"players\":[]}").hold);
        Assert.IsFalse(ResultSummary.Parse(OneRun).hold, "no word from the page is no hold");
    }

    // THE WRECK (round 3b16e292 as the seats signed it, 00:14:07Z): this player FAILED, signed by 7, settlement pending
    [Test]
    public void AWreckReadsFailedWithItsStakeAndNoHighScore()
    {
        const string wreck = "{\"mine\":\"32dc\",\"hold\":true,\"players\":[{\"entry\":\"32dc\",\"key\":\"8559fc1f\",\"name\":\"\",\"outcome\":\"FAILED\",\"score\":4147753,\"signedBy\":7,\"result\":\"pending\",\"net\":\"\",\"stakeMsat\":\"100000\"}]}";
        Assert.AreEqual(new[] {
            "FAILED you",
            "HIGH SCORE  -",
            "YOU  FAILED  ·  pending",
            "preliminary · 1 of 1 runs signed",
            "you  stake 100 sat  ·  pending",
        }, ResultSummary.Lines(ResultSummary.Parse(wreck)).ToArray());
        Assert.AreEqual("", ResultSummary.Stake("0"), "a free entry names no stake");
    }
}
