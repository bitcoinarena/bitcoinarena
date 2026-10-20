// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using NUnit.Framework;

/// <summary>
/// §11.4/§11.5: a DOWNED man is laid on the dirt, not buried in it.
///
/// This is the guard the pose itself could not have. `PostureDrawTests` has to Assert.Ignore because the editor
/// has no core - `ArenaCore.Available` is a browser extern, every unit reads dead, and `ArmyRenderer` draws no men
/// at all - so a test that walks the draw path proves nothing there. The lift arithmetic is not like that: it is
/// a pure function of posture and which anchor the model has, it consults no core and no scene, and it is exactly
/// where the fault was. So it can be asserted here and it runs.
///
/// WHAT WENT WRONG, and what these numbers are: `WrapOnItsSole` puts a real prefab's origin at the man's SOLES,
/// while the fallback box is CENTRE-anchored and stands at 0.9. `soldierProneDrop` of 0.75 is the box's
/// correction - 0.9 - 0.75 = 0.15, about half a body's thickness. Applied to the sole-anchored prefab, whose
/// standing lift is 0, the same subtraction drew a downed man at ground - 0.75. Measured over 2 seeds x 40 s,
/// 20550 man-ticks standing on a hole with 98.9% of them DOWN, every one sat 0.74 m under the surface his own
/// feet stood on - the same figure on candle lips, crater rims and wrecks, which is how the crater bowl was ruled
/// out as the cause.
/// </summary>
public class SoldierLiftTests
{
    const float Drop = 0.75f;      // ArmyRenderer.soldierProneDrop's default

    [Test]
    public void ASoleAnchoredManIsDrawnOnTheGroundStandingOrDown()
    {
        Assert.AreEqual(0f, ArmyRenderer.SoldierLift(false, true, Drop), 1e-4f,
            "a standing prefab man's origin is his soles, so he stands ON the ground");
        // The whole point of the letter: no drop at all on this path. The 82-degree pitch applied after the lift
        // swings his body down about his own feet, which is what lying down is.
        Assert.AreEqual(0f, ArmyRenderer.SoldierLift(true, true, Drop), 1e-4f,
            "a downed prefab man is laid on the ground, not driven 0.75 m under it");
    }

    [Test]
    public void TheFallbackBoxKeepsTheNumbersItWasTunedFor()
    {
        Assert.AreEqual(ArmyRenderer.BoxStandLift, ArmyRenderer.SoldierLift(false, false, Drop), 1e-4f,
            "the box is centre-anchored and stands at half its height");
        Assert.AreEqual(0.15f, ArmyRenderer.SoldierLift(true, false, Drop), 1e-4f,
            "laid flat the box sits at about half its thickness - 0.9 - 0.75, unchanged by this letter");
    }

    /// <summary>
    /// The fault in the form it actually took, so a revert cannot pass quietly: subtracting the box's drop from
    /// the sole-anchored path is what buried the men, and no posture on that path may ever be negative.
    /// </summary>
    [Test]
    public void NoManIsEverDrawnBelowTheGroundHeStandsOn()
    {
        foreach (var down in new[] { false, true })
            foreach (var hasPrefab in new[] { false, true })
                Assert.GreaterOrEqual(ArmyRenderer.SoldierLift(down, hasPrefab, Drop), 0f,
                    $"down={down} hasPrefab={hasPrefab} draws a man under the ground");
    }
}
