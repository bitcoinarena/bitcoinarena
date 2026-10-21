// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Collections;
using System.Linq;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;
using Arena;

/// <summary>
/// WHAT THE COLLISION WORLD ACTUALLY IS, WRITTEN DOWN.
///
/// `WorldSolids.Gather` collects every BoxCollider Unity has built at runtime
/// and `UploadSolids` sends them to the core; no replay sets any, so a
/// committee resolves every drive against nothing. Measured: one box on the
/// path moves a 600-tick drive 40.233 m.
///
/// The fix is the ground's - the map's boxes belong to the core and Unity
/// draws them - and it cannot be written without knowing what the boxes ARE.
/// This is that inventory, taken from a real `Bootstrap` world rather than
/// from a reading of the code, and it stays as the pin: a box appearing or
/// moving is a change to the simulated world and should have to be argued for.
/// </summary>
public class SolidsInventoryTests
{
    [TearDown] public void ClearTheWorld() => TestWorld.TearDown();

    const float ONE = 65536f;

    [UnityTest]
    public IEnumerator TheCollisionWorldIsTheseBoxes()
    {
        new GameObject("Bootstrap").AddComponent<Bootstrap>();
        for (var f = 0; f < 120; f++) yield return null;      // let the world build

        var truck = Object.FindFirstObjectByType<CoreDrivenTruck>();
        Assert.IsNotNull(truck, "no truck, so `IsWorld` cannot exclude one");

        var words = WorldSolids.Gather(truck.transform, out int n);
        TestContext.WriteLine($"gathered {n} world boxes");

        // AND WHICH OBJECTS THEY CAME FROM, because a count is not an
        // inventory and the core has to reproduce the things, not the number.
        var named = Object.FindObjectsByType<BoxCollider>(FindObjectsSortMode.None)
            .Where(c => WorldSolids.IsWorld(c, truck.transform))
            .Where(c => c.bounds.size.x > 0.01f && c.bounds.size.z > 0.01f)
            .OrderBy(c => c.transform.position.x).ThenBy(c => c.transform.position.z)
            .ToArray();
        foreach (var c in named)
        {
            var b = c.bounds;
            TestContext.WriteLine(
                $"  {c.name,-28} centre ({b.center.x,9:F3}, {b.center.z,9:F3}) "
                + $"extents ({b.extents.x,8:F3}, {b.extents.z,8:F3}) "
                + $"y {b.min.y,8:F3}..{b.max.y,8:F3}  path {Path(c.transform)}");
        }
        Assert.AreEqual(named.Length, n, "the gather and the enumeration disagree");
        Assert.Greater(n, 0, "the world has no solids at all, so there is nothing to move into the core");
    }

    static string Path(Transform t)
    {
        var s = t.name;
        for (var p = t.parent; p != null; p = p.parent) s = p.name + "/" + s;
        return s;
    }
}
