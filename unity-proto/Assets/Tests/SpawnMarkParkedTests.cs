// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Collections;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

/// <summary>
/// "IN ITS BAY" IS A TWO-DIMENSIONAL QUESTION, BECAUSE THE CORE'S IS (2026-09-16).
///
/// `SpawnMark` re-asks the post office where the bay is whenever `MempoolTerrain` rebuilds, and puts a
/// still-held truck back on it. It used to decide "still in its bay" on a THREE-dimensional distance
/// against a mark whose height moves with the ground. The core's rule is two-dimensional:
/// `ArenaCore.Teleport` takes x and z and drops y, because the core recomputes height from its own
/// surface. A 3-D budget therefore counts a HEIGHT-ONLY rebuild as movement and skips a re-seat on a
/// truck the core still has standing in its bay.
///
/// Measured live on the Daily, that difference never showed: over two runs of five terrain rebuilds
/// each, every firing rebuild read 2-D 0.00 m against 3-D 0.24 m, and the one rebuild whose mark height
/// actually moved had the truck 80 m away, so both measures agreed and neither fired. The change was
/// correct and silent. This test is the case the Daily did not produce - a truck already standing in
/// the bay when the ground under it moves by more than the whole parked budget.
///
/// It asserts the RULE, not a survival time, and it loosens nothing: `parkedWithin` stays at its
/// shipped value and the 3-D distance is recorded rather than accommodated.
///
/// THERE IS NO CORE IN PLAYMODE. `ArenaInit` is a stub that returns 0, so `ArenaCore.Available` is false
/// and `Teleport` returns false without moving anything. The third number is therefore what the code
/// COMMANDS in x/z - the spawn mark against the truck's own x/z - and it is labelled commanded rather
/// than dressed up as core movement.
/// </summary>
public class SpawnMarkParkedTests
{
    [TearDown] public void ClearTheWorld() => TestWorld.TearDown();

    [SetUp] public void PracticeOffSoNothingIsWithheld() => Arena.PracticeMode.On = false;

    GameObject _boot;
    TruckController _truck;
    MempoolTerrain _terrain;
    PostOffice _post;
    SpawnMark _mark;

    [UnitySetUp]
    public IEnumerator SetUp()
    {
        _boot = new GameObject("Bootstrap");
        _boot.AddComponent<Bootstrap>();
        yield return new WaitForSeconds(1.5f);

        var splash = Object.FindFirstObjectByType<SplashScreen>();
        if (splash != null && splash.Showing) splash.Play();
        yield return null;

        _truck = Object.FindFirstObjectByType<TruckController>();
        _terrain = Object.FindFirstObjectByType<MempoolTerrain>();
        _post = Object.FindFirstObjectByType<PostOffice>();
        _mark = Object.FindFirstObjectByType<SpawnMark>();
        yield return null;
    }

    /// <summary>
    /// The ground under the bay moves and nothing else does: the truck is still in its bay, and the
    /// re-seat still happens.
    ///
    /// The lift is made with `feeHeight`, which scales the one flat term the apron is built from. The
    /// bay stands at postX + bayStandoff = -100.4, which is u = 0.06 of a 260 m map - inside
    /// `apronLevelFraction` 0.19, where `HeightAt` is exactly log10(1 + fee) * feeHeight and nothing
    /// else. So raising it moves the mark's y and leaves its x and z untouched, which is the whole
    /// point: a pure height change, the case the live runs never produced.
    /// </summary>
    [UnityTest]
    public IEnumerator AHeightOnlyRebuildStillCountsAsStandingInTheBay()
    {
        Assert.IsNotNull(_mark, "no SpawnMark in the scene");
        Assert.IsNotNull(_terrain, "no MempoolTerrain in the scene");
        Assert.IsNotNull(_post, "no PostOffice in the scene");
        Assert.IsTrue(_post.HasBay, "the bay is not known yet");

        // Park it exactly where the bay is, and hold it: `held` is what SpawnMark asks before it
        // re-seats anything, and a truck under way is deliberately left alone.
        var bay = _post.BayFor(PostOffice.SoloBay);
        _truck.transform.position = bay;
        _truck.spawnPosition = bay;
        _truck.controlsLocked = true;
        yield return null;

        // Now move ONLY the height. Nothing touches x or z.
        float wasHeight = _terrain.feeHeight;
        _terrain.feeHeight = wasHeight + 40f;
        _terrain.Build();                       // bumps Version, which is what SpawnMark watches
        yield return null;                      // LateUpdate runs here

        var lifted = _post.BayFor(PostOffice.SoloBay);
        float dy = Mathf.Abs(lifted.y - bay.y);

        // THE THREE NUMBERS, all measured against the mark the truck was parked on.
        float d3Mark = Vector3.Distance(bay, lifted);          // what 3-D would have measured
        float d2Mark = Vector2.Distance(new Vector2(bay.x, bay.z), new Vector2(lifted.x, lifted.z));
        float commandedXZ = Vector2.Distance(new Vector2(_truck.spawnPosition.x, _truck.spawnPosition.z),
                                             new Vector2(bay.x, bay.z));

        Debug.Log($"[spawnmark-test] ground lifted {dy:F2} m: mark {bay.y:F2} -> {lifted.y:F2}; "
                  + $"3-D to the mark {d3Mark:F2} m, 2-D to the mark {d2Mark:F2} m, "
                  + $"commanded x/z displacement {commandedXZ:F2} m, of {_mark.parkedWithin:F1} m parked");

        // The case has to be the one that separates the two rules, or it proves nothing.
        Assert.Greater(d3Mark, _mark.parkedWithin,
            "this test is worthless unless the height change alone exceeds the parked budget - "
            + $"3-D moved {d3Mark:F2} m against a budget of {_mark.parkedWithin:F1} m");

        // The core's rule: x and z did not move, so the truck is still in its bay.
        Assert.Less(d2Mark, _mark.parkedWithin,
            $"x and z did not move, so 2-D must stay inside the parked budget - it read {d2Mark:F2} m");

        // And the re-seat is a no-op across the ground: the mark keeps the same x and z.
        Assert.AreEqual(0f, commandedXZ, 0.01f,
            $"a height-only rebuild must command no movement across the ground - it commanded {commandedXZ:F2} m");

        // The truck is put back on the NEW mark, which is the whole job: same x and z, new height.
        Assert.AreEqual(bay.x, _truck.spawnPosition.x, 0.01f, "the re-seat moved the mark in x");
        Assert.AreEqual(bay.z, _truck.spawnPosition.z, 0.01f, "the re-seat moved the mark in z");
        Assert.AreEqual(lifted.y, _truck.spawnPosition.y, 0.01f,
            "the mark should have followed the ground up");

        _terrain.feeHeight = wasHeight;
    }

    /// <summary>
    /// And a truck that has actually driven off is still left alone, which is the guard the 2-D rule
    /// must not have widened away. Measured live: 80.73 m in both measures, parked False, no fire.
    /// </summary>
    [UnityTest]
    public IEnumerator ATruckThatHasDrivenOffIsNotDraggedBack()
    {
        Assert.IsNotNull(_mark, "no SpawnMark in the scene");
        var bay = _post.BayFor(PostOffice.SoloBay);
        _truck.transform.position = bay + new Vector3(80f, 0f, 0f);   // across the ground, not up
        _truck.spawnPosition = bay;
        _truck.controlsLocked = true;
        yield return null;

        var was = _truck.transform.position;
        _terrain.Build();
        yield return null;

        float moved = Vector3.Distance(_truck.transform.position, was);
        Debug.Log($"[spawnmark-test] 80 m out: truck moved {moved:F2} m on a rebuild");
        Assert.Less(moved, 0.5f,
            $"a truck 80 m from its bay must not be picked up and put back - it moved {moved:F2} m");
    }
}
