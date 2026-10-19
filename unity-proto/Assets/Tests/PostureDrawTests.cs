// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Collections;
using System.Collections.Generic;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

/// <summary>
/// §11.4 / §11.5 ON SCREEN: the renderer lays a man down because the CORE says he is down, not because C# guessed
/// it from a position or a velocity.
///
/// This was the last clause of §11.5 held up only by a count read over CDP from a running build. The word and the
/// pin are asserted in the JS core suite where the rules live; this asserts the half that lives in Unity - that
/// ArmyRenderer reads `ArenaCore.UnitPosture` and poses from it.
///
/// NOTHING HERE TOUCHES PHYSX. The units are kinematic with gravity off (ArmyRenderer sets isKinematic = true,
/// useGravity = false, and ignores unit-vs-unit collision), so a Rigidbody would have nothing to say about a
/// man's pose. The core writes the word; Unity draws it.
/// </summary>
public class PostureDrawTests
{
    [UnityTest]
    public IEnumerator TheRendererLaysAManDownBecauseTheCoreSaysHeIsDown()
    {
        var boot = new GameObject("Bootstrap");
        boot.AddComponent<Bootstrap>();
        yield return new WaitForSeconds(3f);

        var renderer = Object.FindFirstObjectByType<ArmyRenderer>();
        Assert.IsNotNull(renderer, "no ArmyRenderer in the scene");

        // THIS CANNOT RUN IN THE EDITOR, AND IT SAYS SO RATHER THAN PASSING. The core is the JS bundle:
        // `ArenaCore.Available` is set by `ArenaInit`, an extern that exists only in a browser build, so in EditMode
        // and PlayMode the core is stubbed, its state array is zeros, every unit reads DEAD - and the renderer
        // therefore draws no men at all. There is no hook to inject a state: `_state` is private static with no
        // setter.
        //
        // TWO EARLIER VERSIONS OF THIS TEST WERE WORTHLESS AND WERE CAUGHT BY BREAKING THE RENDERER ON PURPOSE.
        // The first asserted the core's down-count against the renderer's and failed on "the core is not running".
        // The second asserted that with no core word nothing may be laid down - which passed, and went on passing
        // when `down` was forced true for every third man, because there are no men to draw. A green over an empty
        // set is not a guard.
        //
        // So it is IGNORED with its reason, which shows up in the skipped count instead of inflating the passed
        // one. It becomes real the day ArenaCore gains a test seam for its state, or the day this suite runs
        // against a browser build. Until then the pose is held by the renderer's own count read over CDP from a
        // running build - a hand measurement, and listed as one.
        if (!Arena.ArenaCore.Available)
            Assert.Ignore("the core is stubbed in the editor, so no man is drawn and nothing about the pose can "
                          + "be asserted here; the pose is measured on a real build over CDP");

        // The positive case, for when the core IS available: what the renderer laid down is what the core said.
        for (int frames = 0; frames < 600; frames++)
        {
            yield return null;
            renderer.Submit();
            int down = 0, men = 0;
            for (int i = 0; i < Arena.Layout.UNITS; i++)
            {
                if (Arena.ArenaCore.UnitIsArmour(i) || !Arena.ArenaCore.UnitAlive(i)) continue;
                men++;
                if (Arena.ArenaCore.UnitPosture(i) != Arena.Layout.POSTURE_STAND) down++;
            }
            Assert.Greater(men, 0, "no living man was drawn, so this frame proves nothing");
            Assert.AreEqual(down, renderer.MenDrawnDown,
                $"frame {frames}: the core has {down} men not STAND and the renderer laid {renderer.MenDrawnDown} down");
        }
    }
}
