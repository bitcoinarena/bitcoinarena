// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using UnityEngine;

/// <summary>
/// Tears a built world down between tests.
///
/// Bootstrap assembles a whole game - terrain, post office, miner, army,
/// camera, truck - as ROOT objects, and [UnitySetUp] runs before every test,
/// not once per fixture. Twelve fixtures created worlds and two cleaned up,
/// so by the end of a run there were dozens of complete games stacked on top
/// of each other: several trucks, several armies, several post offices, all
/// stepping at once.
///
/// That is almost certainly what the suite's intermittent failures were.
/// FindFirstObjectByType picks an arbitrary one of the copies, so a test
/// could set up one truck and measure another; a goggles wall that had
/// finished animating stood next to one that had just been built; and an
/// instrumented count of the block band came back as fifteen faces where the
/// model has five.
/// </summary>
public static class TestWorld
{
    /// <summary>Removes everything a Bootstrap put in the scene.</summary>
    public static void TearDown()
    {
        foreach (var go in Object.FindObjectsByType<GameObject>(
                     FindObjectsInactive.Include, FindObjectsSortMode.None))
        {
            if (go == null || go.transform.parent != null) continue;

            // The runner's own objects stay: destroying those ends the run.
            string n = go.name;
            if (n.Contains("Code-based tests runner")) continue;
            if (n.Contains("PlayModeTestRunner")) continue;
            if (n.StartsWith("Tests (")) continue;

            Object.DestroyImmediate(go);
        }
    }
}
