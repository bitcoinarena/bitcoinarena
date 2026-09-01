using System.Collections;
using System.Text;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

/// <summary>
/// Records how the C# army behaves, so the port into the deterministic core
/// can be held to it rather than to a description of it.
///
/// The same approach the driving took, and for the same reason: the feel of
/// this army is not written down anywhere. It is 700 lines of tuned
/// behaviour - squads that drift, armour that pushes to the line and falls
/// back when overrun, infantry that closes and stops - and the only reliable
/// statement of what it does is what it does.
///
/// Prints a table; asserts nothing.
/// </summary>
public class ArmyReferenceTests
{
    [Test]
    [Explicit("Measurement, not an assertion. Read the ARMYREF lines out of " +
              "the log and paste them into packages/core/test/vectors/.")]
    public void MeasureTheArmy()
    {
        var sb = new StringBuilder();
        sb.AppendLine("ARMYREF BEGIN");

        // A flat, still world: the seam down the middle, no trade flow, no
        // truck. Everything that moves here is the army's own doing.
        var army = new Army(20260901);
        army.FrontlineAt = _ => 0f;
        army.GroundAt = (x, z) => 0f;
        army.Flow = 0f;
        army.Populate(24, 72);

        sb.AppendLine($"ARMYREF spawn armour={army.Armour.Count} infantry={army.Infantry.Count}");
        Row(sb, army, 0f);

        const float dt = 1f / 60f;
        for (int step = 1; step <= 60 * 90; step++)
        {
            army.Update(dt);
            if (step % (60 * 5) == 0) Row(sb, army, step * dt);
        }

        sb.AppendLine("ARMYREF END");
        Debug.Log(sb.ToString());
    }

    /// <summary>
    /// One line of the table: where each side's units are relative to the
    /// seam, how fast they are closing, and how many are still alive.
    /// </summary>
    static void Row(StringBuilder sb, Army army, float t)
    {
        Stats(army.Armour, Army.Side.Bull, out float av, out float ad, out int an);
        Stats(army.Armour, Army.Side.Bear, out float bv, out float bd, out int bn);
        Stats(army.Infantry, Army.Side.Bull, out float iv, out float idd, out int inn);
        Stats(army.Infantry, Army.Side.Bear, out float jv, out float jd, out int jn);

        sb.AppendLine($"ARMYREF t={t:0.0} " +
                      $"bullArmour n={an} z={ad:0.00} spread={av:0.00} " +
                      $"bearArmour n={bn} z={bd:0.00} spread={bv:0.00} " +
                      $"bullInf n={inn} z={idd:0.00} spread={iv:0.00} " +
                      $"bearInf n={jn} z={jd:0.00} spread={jv:0.00}");
    }

    static void Stats(System.Collections.Generic.List<Army.Unit> units, Army.Side side,
                      out float spread, out float meanZ, out int alive)
    {
        float sum = 0f; alive = 0;
        foreach (var u in units)
        {
            if (u.side != side || u.hp <= 0f) continue;
            sum += u.z; alive++;
        }
        meanZ = alive > 0 ? sum / alive : 0f;

        float var2 = 0f;
        foreach (var u in units)
        {
            if (u.side != side || u.hp <= 0f) continue;
            float d = u.z - meanZ; var2 += d * d;
        }
        spread = alive > 1 ? Mathf.Sqrt(var2 / alive) : 0f;
    }
}
