// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using NUnit.Framework;
using UnityEngine;

/// <summary>
/// WHAT ACTUALLY HITS A PARKED TRUCK, in the retired C# army.
///
/// M1.a14's third bullet says tanks and soldiers do not shoot and that HUNTED
/// looks dead. Before anything is changed, the two engines have to be asked
/// the same question, and this is the C# half of it: park the courier where
/// the army can reach it, let the army run, and count what lands on it.
///
/// `Army.CourierHit` is raised from two places and carries only a float, so
/// the two weapons are told apart by the size of the hit, which is what the
/// core's own port relies on: `Army.cs:638` in `StepArmour` is a tank shell,
/// `Rand(5f, 11f)`, and `Army.cs:737` in `StepInfantry` is a rifle round,
/// `Rand(1.5f, 3.5f)`. With `Heat` at zero - the value every recording in
/// this repo was taken at - the two bands cannot meet.
///
/// ONE THING THIS MEASUREMENT CHANGES BY BEING TAKEN, and it is written down
/// rather than hidden: `CourierHit?.Invoke(Rand(...))` evaluates its argument
/// only when something is subscribed, so attaching a listener draws numbers a
/// silent run does not and the battle is not bit-identical to an unwatched
/// one. The SHARE is what this is for, and the share does not turn on which
/// draw a shell took.
///
/// Explicit: a measurement, not an assertion. Read the [hunted] lines.
/// </summary>
public class ArmyDamageReferenceTests
{
    /// <summary>The establishment the C# recording in csharp-army.json used.</summary>
    const int ArmourPerSide = 24, InfantryPerSide = 72;

    /// <summary>What the core gives the truck before it is written off.</summary>
    const float TruckHealth = 100f;

    [Test]
    [Explicit("Measurement, not an assertion. Read the [hunted] lines out of the log.")]
    public void MeasureWhatHitsAParkedTruck()
    {
        foreach (float z in new[] { 0f, -5f, -12f, -25f, -34f })
            Run(z, 0f);
    }

    /// <summary>
    /// WHAT THE FREIGHT CHOICE WAS SUPPOSED TO COST, and never did.
    ///
    /// `Army.Heat` is documented as "how badly both sides want the truck, set
    /// from what it is carrying - without this the freight choice had no
    /// consequence at all". It widens the reach the truck is noticed at
    /// (`CourierRange * (1 + Heat * 1.4)`), lets the truck outrank a nearer
    /// tank (`cd < fd * (1 + Heat * 2.5)`) and multiplies the shell
    /// (`Rand(5,11) * (1 + Heat * 0.6)`).
    ///
    /// NOTHING IN THE SHIPPED C# EVER ASSIGNED IT. A grep for an assignment
    /// finds two test files, both setting it to zero. So the field existed,
    /// the rule existed, and the load never made the war want you more - which
    /// is the same thing the core does today by hardcoding the Heat-zero
    /// specialisation. This sweep is what the coupling would have been worth.
    /// </summary>
    [Test]
    [Explicit("Measurement, not an assertion. Read the [hunted] lines out of the log.")]
    public void MeasureWhatHeatWouldHaveCost()
    {
        foreach (float heat in new[] { 0f, 0.5f, 1f })
            Run(-25f, heat);
    }

    static void Run(float z, float heat)
    {
        var army = new Army(20260901) { FrontlineAt = _ => 0f, Heat = heat };
        army.Populate(ArmourPerSide, InfantryPerSide);

        int shells = 0, rounds = 0;
        float shellDmg = 0f, rifleDmg = 0f;

        // The bands are 5..11 and 1.5..3.5 at Heat 0, so three is the gap
        // between them and not a number chosen to make a total come out. Heat
        // widens the shell's band and not the rifle's, so above zero the split
        // is reported as "3 and over" rather than claimed as exact.
        army.CourierHit += d =>
        {
            if (d >= 3f) { shells++; shellDmg += d; }
            else { rounds++; rifleDmg += d; }
        };

        const float dt = 1f / 60f;
        int ticks = 0;
        for (int i = 0; i < 90 * 60; i++)
        {
            army.Courier = new Vector2(0f, z);      // parked, and held there
            army.Update(dt);
            ticks++;
            // Stopped where the core stops: damage is withheld once the truck
            // is written off, so counting past it reports a battle nobody was
            // in. The C# army has no notion of the truck's health, so the
            // window is closed here instead.
            if (shellDmg + rifleDmg >= TruckHealth * 1.5f) break;
        }

        float shot = shellDmg + rifleDmg;
        Debug.Log($"[hunted] C# parked at z={z:0.#} heat={heat:0.00}: {ticks / 60f:0.00} s, "
                  + $"{shells} shell(s) for {shellDmg:0.0}, {rounds} round(s) for "
                  + $"{rifleDmg:0.0}, tank share of damage to the truck "
                  + (shot > 0f ? $"{shellDmg / shot * 100f:0.0}%" : "no damage at all"));
    }
}
