// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using NUnit.Framework;
using UnityEngine;

/// <summary>
/// THE COLLECT'S LINES IN THE LOBBY (2026-10-07): the page writes up to three strings - another kept seed's
/// record, a failed collect, an uncollectable record - and their kind; Unity draws them under the round rows, one colour per
/// kind, and draws nothing when the page wrote none. These read the page's JSON as the lobby does (JsonUtility).
/// </summary>
public class CollectLinesTests
{
    const string Three = "{\"mode\":\"lobby\",\"collect\":["
        + "{\"text\":\"Other kept seed 839b67a6: round 5718b249 open, collected too\",\"kind\":\"other\"},"
        + "{\"text\":\"Collect failed for round 5718b249: the federation did not answer - tried again\",\"kind\":\"failed\"},"
        + "{\"text\":\"Uncollectable: round 5718b249 (seed 4f5c6976) - its seed is not kept in this browser: no key is left to collect it\",\"kind\":\"uncollectable\"}]}";

    [Test]
    public void TheThreeLinesAreDrawnAsThePageWroteThem()
    {
        var s = JsonUtility.FromJson<Arena.LobbyState>(Three);
        var lines = Arena.DailyLobby.CollectLines(s);
        Assert.AreEqual(3, lines.Length);
        Assert.AreEqual("Other kept seed 839b67a6: round 5718b249 open, collected too", lines[0].text);
        Assert.AreEqual("Collect failed for round 5718b249: the federation did not answer - tried again", lines[1].text);
        StringAssert.StartsWith("Uncollectable: round 5718b249 (seed 4f5c6976)", lines[2].text);
        Assert.AreEqual(new[] { "other", "failed", "uncollectable" }, System.Array.ConvertAll(lines, (l) => l.kind));
    }

    [Test]
    public void EachKindHasItsOwnColour()
    {
        Color other = Arena.DailyLobby.CollectColour("other"), failed = Arena.DailyLobby.CollectColour("failed"), lost = Arena.DailyLobby.CollectColour("uncollectable");
        Assert.Greater(failed.r, failed.g + 0.3f, "failed is red");
        Assert.Greater(lost.r, lost.b + 0.5f, "uncollectable is orange");
        Assert.Greater(lost.g, failed.g, "orange is not the same red");
        Assert.Greater(other.b, other.r, "another kept seed is grey-blue");
    }

    [Test]
    public void NothingIsDrawnWhenThePageWroteNoLine()
    {
        Assert.AreEqual(0, Arena.DailyLobby.CollectLines(JsonUtility.FromJson<Arena.LobbyState>("{\"mode\":\"lobby\"}")).Length, "no collect field");
        Assert.AreEqual(0, Arena.DailyLobby.CollectLines(JsonUtility.FromJson<Arena.LobbyState>("{\"mode\":\"lobby\",\"collect\":[]}")).Length, "an empty list");
        Assert.AreEqual(0, Arena.DailyLobby.CollectLines(JsonUtility.FromJson<Arena.LobbyState>("{\"collect\":[{\"text\":\"\",\"kind\":\"other\"}]}")).Length, "an empty string");
        Assert.AreEqual(0, Arena.DailyLobby.CollectLines(null).Length, "no lobby");
    }

    [Test]
    public void AtMostThreeLines()
    {
        var s = JsonUtility.FromJson<Arena.LobbyState>(Three.Replace("]}", ",{\"text\":\"a fourth\",\"kind\":\"other\"}]}"));
        Assert.AreEqual(4, s.collect.Length);
        Assert.AreEqual(3, Arena.DailyLobby.CollectLines(s).Length);
    }
}
