// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.IO;
using System.Text.RegularExpressions;
using NUnit.Framework;
using UnityEngine;
using Arena;

/// <summary>
/// THE COLOURED BOXES ARE THE CORE'S (2026-09-25 20:56/20:57: visible collisions on the miner and the post office).
/// The view reads st.solids through the bridge and draws the boxes the truck's body can reach; these pin the parts of
/// that which live on the C# side against the core's own source.
/// </summary>
public class CollisionBoxViewTests
{
    static string Core(string rel) => File.ReadAllText(Path.Combine(Application.dataPath, "../../packages/nextblock/src", rel));

    [Test]
    public void TheBodyHeightIsTheCoresOwn()
    {
        var m = Regex.Match(Core("rules/solids.js"), @"export const BODY_HEIGHT = (\d+);");
        Assert.IsTrue(m.Success, "solids.js no longer names BODY_HEIGHT");
        Assert.AreEqual(int.Parse(m.Groups[1].Value), CollisionBoxView.BodyHeight);
    }

    [Test]
    public void TheVerticalRuleIsPushOuts()
    {
        var src = Core("rules/solids.js");
        StringAssert.Contains("if (yLow > add(floor, BODY_HEIGHT)) continue;", src);
        StringAssert.Contains("if (yHigh < floor) continue;", src);
        int floor = 10 * ArenaCore.ONE;
        Assert.IsTrue(CollisionBoxView.TruckCanHit(floor - 20 * ArenaCore.ONE, floor + 52 * ArenaCore.ONE, floor), "a post office pillar");
        Assert.IsFalse(CollisionBoxView.TruckCanHit(floor + 602931, floor + 52 * ArenaCore.ONE, floor), "a lintel 9.2 m up is driven under");
        Assert.IsTrue(CollisionBoxView.TruckCanHit(floor + CollisionBoxView.BodyHeight, floor + 20 * ArenaCore.ONE, floor), "a box at roof height is met");
    }

    [Test]
    public void TheTwoBuildingsTakeTwoColoursThatLetTheBuildingThrough()
    {
        Assert.AreNotEqual(CollisionBoxView.PostOffice, CollisionBoxView.Miner);
        Assert.AreEqual(CollisionBoxView.PostOffice, CollisionBoxView.ColourOf(-7497318), "the post office at x -114.4");
        Assert.AreEqual(CollisionBoxView.Miner, CollisionBoxView.ColourOf(11075584), "the miner at x 169");
        Assert.Less(CollisionBoxView.PostOffice.a, 0.5f);
        Assert.Less(CollisionBoxView.Miner.a, 0.5f);
    }

    [Test]
    public void TheBridgeCopiesTheCoresSolidsAndNotUnitysColliders()
    {
        var lib = File.ReadAllText(Path.Combine(Application.dataPath, "Plugins/WebGL/arena.jslib"));
        StringAssert.Contains("var s = b.st.solids;", lib);
        var view = File.ReadAllText(Path.Combine(Application.dataPath, "Scripts/Arena/CollisionBoxView.cs"));
        StringAssert.DoesNotContain("Collider", Regex.Replace(view, @"///.*|//.*", ""));
        StringAssert.DoesNotContain(".bounds", view);
    }
}
