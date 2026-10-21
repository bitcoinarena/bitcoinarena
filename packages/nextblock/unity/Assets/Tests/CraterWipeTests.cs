// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Collections;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

/// <summary>
/// A LIQUIDATION WIPES ITS RADIUS.
///
/// A burnt-out hull standing in a hole the blast has just opened is the thing
/// the bullet forbids, and nothing removed one before this. Measured on the
/// running build it is rare - 1 wreck inside a 33.5 m crater in one strike, 0
/// in three others - which is exactly why it needs a test rather than a run:
/// waiting for the case to turn up by luck proves nothing when it does not.
///
/// The list is `Army.Wrecks`, the one `CombatFx.ClaimWreckSlot` fills and
/// `Retire` releases. The core has no word for a wreck - `army.js` says so
/// where it pushes LIVE units out of a crater, "the WRECKS stay out" - so
/// there is no core list to wipe and no second list is invented here.
/// </summary>
public class CraterWipeTests
{
    [TearDown] public void ClearTheWorld() => TestWorld.TearDown();

    [UnityTearDown]
    public IEnumerator TearDown()
    {
        // `WastedSequence` slows the clock when the truck is written off, and
        // tearing the scene down mid-sequence leaves it slowed. The next
        // time-sensitive test then measures nothing moving in two seconds -
        // `PostOfficeTests.TheGogglesAnimate` went red exactly that way.
        // `StrikeSeamTests` resets it for the same reason.
        Time.timeScale = 1f;
        foreach (var go in Object.FindObjectsByType<GameObject>(FindObjectsSortMode.None))
            if (go.transform.parent == null) Object.Destroy(go);
        yield return null;

        // AND PUT THE SCENE BACK, rather than leaving an empty world behind.
        // Destroying every root leaves nothing for the next fixture to find,
        // and `PostOfficeTests.TheGogglesAnimate` went red on exactly that -
        // green alone, green after StrikeSeamTests which rigs Bootstrap the
        // same way and does not run a round, red after either of these two.
        UnityEngine.SceneManagement.SceneManager.LoadScene(
            0, UnityEngine.SceneManagement.LoadSceneMode.Single);
        yield return null;
    }

    CombatFx _fx;

    IEnumerator Rig()
    {
        var boot = new GameObject("Bootstrap");
        boot.AddComponent<Bootstrap>();
        for (int i = 0; i < 6; i++) yield return null;

        var splash = Object.FindFirstObjectByType<SplashScreen>();
        if (splash != null && splash.Showing) splash.Play();
        yield return null;

        _fx = Object.FindFirstObjectByType<CombatFx>();
        Assert.IsNotNull(_fx, "no CombatFx in the scene");
        yield return null;
    }

    static int HullsWithin(Vector3 at, float r)
    {
        int n = 0;
        foreach (var h in Object.FindObjectsByType<BurntOutHull>(FindObjectsSortMode.None))
        {
            var p = h.transform.position;
            if (new Vector2(p.x - at.x, p.z - at.z).magnitude <= r) n++;
        }
        return n;
    }

    [UnityTest]
    public IEnumerator AHullStandingInTheCraterIsGone()
    {
        yield return Rig();

        var at = new Vector3(20f, 0f, -12f);
        const float radius = 25f;

        // three inside the bowl, one well outside it
        _fx.Wreck(at + new Vector3(0f, 0f, 0f), 0f);
        _fx.Wreck(at + new Vector3(8f, 0f, 4f), 1f);
        _fx.Wreck(at + new Vector3(-6f, 0f, -9f), 2f);
        _fx.Wreck(at + new Vector3(60f, 0f, 0f), 3f);
        yield return null;

        int before = HullsWithin(at, radius);
        int outsideBefore = HullsWithin(at + new Vector3(60f, 0f, 0f), 3f);
        Assert.AreEqual(3, before, "the test did not put three hulls in the hole");
        Assert.AreEqual(1, outsideBefore, "the test did not put one hull outside it");

        int wiped = _fx.ClearWrecksIn(at, radius);
        yield return null;

        Assert.AreEqual(3, wiped, "the wipe must report what it took");
        Assert.AreEqual(0, HullsWithin(at, radius),
                        "no burnt hull may be left standing inside the crater");
        Assert.AreEqual(1, HullsWithin(at + new Vector3(60f, 0f, 0f), 3f),
                        "and a hull outside the radius must be left alone");
    }

    /// <summary>
    /// THE WIRING, not just the method. `StrikeTheatre.fx` was null in every
    /// build: `Fx` is made inside BuildArmies and the theatre is made later,
    /// so `if (_strike != null) _strike.fx = Fx;` was skipped without a word.
    /// The wipe called through a null and took nothing, while the test above
    /// passed because it called `ClearWrecksIn` directly.
    /// </summary>
    [UnityTest]
    public IEnumerator TheTheatreCanReachTheWreckage()
    {
        yield return Rig();
        var theatre = Object.FindFirstObjectByType<Arena.StrikeTheatre>();
        Assert.IsNotNull(theatre, "no StrikeTheatre in the scene");
        Assert.IsNotNull(theatre.fx,
            "the theatre cannot wipe a crater it has no CombatFx to wipe it with");
    }

    // There is no second test on `Army.Wrecks`. `CombatFx.army` is never
    // assigned anywhere in this build - the C# Army is retired - so
    // `ClaimWreckSlot` always returns -1 and the list is always empty. A test on it
    // would assert on dead code and pass whatever the wipe did. `Retire` still
    // releases the slot, so the behaviour is there if the list ever lives
    // again; it is simply not something this build can show.
}
