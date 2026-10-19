// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using NUnit.Framework;

/// <summary>
/// THE BARREL POINTS AT THE TRUCK THE CORE JUST HIT.
///
/// Both engines put 100% of a parked truck's damage on tank shells and write
/// it off in twelve to twenty seconds. The picture said otherwise: the muzzle
/// search only ever considered other units - it skipped the dead, the wrong
/// arm and its own side, and the truck was not in the list at all - so the
/// shell the core spent on the player was drawn going at some other tank, or
/// down the unit's heading. Hit hard, repeatedly, and never shown a barrel
/// pointed at him.
///
/// `CombatFx.ShotGoesAtTheCourier` is the core's own rule and not a new one:
/// the courier outranks the enemy the unit had picked when it is inside the
/// reach for that arm AND nearer than that enemy, and only once a foe has
/// been found at all - `sim.js` at both firing sites, where a unit with
/// nobody in range does not fire at the truck standing beside it.
///
/// The reaches are the two the core uses and they are NOT the same number:
/// `COURIER_RANGE` is 34 m for a tank and the rifleman's courier reach is his
/// own `RIFLE_RANGE`, 26 m. Mixing them is the mistake this file exists to
/// catch, so both are driven at a distance that only one of them allows.
///
/// EditMode, because it is arithmetic on a rule and wants no scene, no core
/// and no frame.
/// </summary>
public class CourierMuzzleTests
{
    static float Sq(float d) => d * d;

    [Test]
    public void ATankShootsTheTruckWhenItIsNearerThanTheTankItHadPicked()
    {
        Assert.IsTrue(CombatFx.ShotGoesAtTheCourier(true, Sq(20f), true, Sq(30f)),
            "the shell went at the truck and the barrel is pointed somewhere else");
    }

    [Test]
    public void ATankLeavesTheTruckAloneBeyondItsCourierReach()
    {
        Assert.IsFalse(CombatFx.ShotGoesAtTheCourier(true, Sq(40f), true, Sq(45f)),
            "the truck is 40 m away, past the 34 m the core allows");
    }

    [Test]
    public void TheNEARERTargetWinsAndTheTruckIsNotAlwaysIt()
    {
        Assert.IsFalse(CombatFx.ShotGoesAtTheCourier(true, Sq(20f), true, Sq(10f)),
            "the tank it had picked was 10 m off and the truck 20 - the core "
            + "shot the tank, so the tracer must go at the tank");
    }

    /// <summary>
    /// The rifleman's courier reach is his rifle's 26 m, not the tank's 34.
    /// At 30 m a tank takes the truck and a rifleman does not, which is the
    /// one distance that tells the two constants apart.
    /// </summary>
    [Test]
    public void ARiflemanReachesTheTruckSixMetresLessFarThanATank()
    {
        Assert.IsTrue(CombatFx.ShotGoesAtTheCourier(true, Sq(30f), true, Sq(40f)),
            "34 m is the tank's reach to the courier");
        Assert.IsFalse(CombatFx.ShotGoesAtTheCourier(false, Sq(30f), true, Sq(40f)),
            "a rifleman reaches 26 m to the courier, not the tank's 34");
    }

    [Test]
    public void ARiflemanShootsTheTruckInsideHisOwnReach()
    {
        Assert.IsTrue(CombatFx.ShotGoesAtTheCourier(false, Sq(12f), true, Sq(20f)));
    }

    /// <summary>
    /// A unit with nobody in range does not fire at the truck beside it. The
    /// core only reaches the courier test once `pickTarget` has returned a
    /// foe, so a renderer that dropped that condition would draw shots the
    /// core never took.
    /// </summary>
    [Test]
    public void NobodyInRangeMeansNoShotAtTheTruckEither()
    {
        Assert.IsFalse(CombatFx.ShotGoesAtTheCourier(true, Sq(5f), false, float.MaxValue),
            "the truck was five metres away and the core still did not fire");
    }

    /// <summary>
    /// Both comparisons are strict in the core - `toTruck < COURIER_RANGE` and
    /// `toTruck < foe` - so a truck exactly at the reach, or exactly as far as
    /// the foe, is not the target. Pinned because an edge that flips silently
    /// is the kind that gets tuned later.
    /// </summary>
    [Test]
    public void TheEdgesAreTheCoresEdges()
    {
        Assert.IsFalse(CombatFx.ShotGoesAtTheCourier(true, Sq(34f), true, Sq(40f)),
            "exactly at the reach is outside it");
        Assert.IsFalse(CombatFx.ShotGoesAtTheCourier(true, Sq(20f), true, Sq(20f)),
            "exactly as far as the foe is not nearer than the foe");
    }
}
