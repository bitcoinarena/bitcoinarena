using NUnit.Framework;
using UnityEngine;

/// <summary>
/// Effects have to appear when guns go off and disappear afterwards. A leak
/// here is invisible until the frame rate dies, so the retirement is pinned as
/// firmly as the spawning.
/// </summary>
public class CombatFxTests
{
    static CombatFx Rig()
    {
        var go = new GameObject("Fx");
        var fx = go.AddComponent<CombatFx>();
        var mat = new Material(Shader.Find("Universal Render Pipeline/Lit") ?? Shader.Find("Standard"));
        fx.tracerMaterial = fx.flashMaterial = fx.blastMaterial = fx.bullMaterial = fx.bearMaterial = mat;
        return fx;
    }

    [Test]
    public void RifleFireProducesAFlashAndATracer()
    {
        var fx = Rig();
        var army = new Army(3) { FrontlineAt = _ => 0f };
        army.Populate(0, 20);
        fx.Bind(army);

        for (int i = 0; i < 60 * 20; i++) army.Update(1f / 60f);
        Assert.Greater(fx.LivePieces, 0, "es wird geschossen, aber nichts ist zu sehen");
        Object.DestroyImmediate(fx.gameObject);
    }

    [Test]
    public void TankFireProducesABlast()
    {
        var fx = Rig();
        var army = new Army(4) { FrontlineAt = _ => 0f };
        army.Populate(6, 0);
        fx.Bind(army);

        for (int i = 0; i < 60 * 30; i++) army.Update(1f / 60f);
        Assert.Greater(fx.LivePieces, 0, "Panzer feuern, ohne dass etwas erscheint");
        Object.DestroyImmediate(fx.gameObject);
    }

    [Test]
    public void EffectsRetireInsteadOfPilingUp()
    {
        var fx = Rig();
        var army = new Army(5) { FrontlineAt = _ => 0f };
        army.Populate(8, 60);
        fx.Bind(army);

        for (int i = 0; i < 60 * 60; i++) { army.Update(1f / 60f); fx.Step(1f / 60f); }
        int during = fx.LivePieces;

        // guns fall silent; everything must clear
        for (int i = 0; i < 60 * 12; i++) fx.Step(1f / 60f);
        Assert.AreEqual(0, fx.LivePieces, $"{fx.LivePieces} Effekte haengen fest (waehrend des Gefechts {during})");
        Object.DestroyImmediate(fx.gameObject);
    }

    [Test]
    public void EffectCountIsCapped()
    {
        var fx = Rig();
        fx.maxPieces = 40;
        for (int i = 0; i < 500; i++) fx.Flash(Vector3.zero, 1f);
        Assert.LessOrEqual(fx.LivePieces, 40, "die Obergrenze fuer Effekte greift nicht");
        Object.DestroyImmediate(fx.gameObject);
    }

    [Test]
    public void ADeadRiflemanTopplesBeforeHeDisappears()
    {
        var fx = Rig();
        fx.Body(Vector3.zero, 0f, true);
        var t = fx.transform.GetChild(0);
        Quaternion upright = t.rotation;

        fx.Step(0.5f);
        Assert.Greater(Quaternion.Angle(upright, t.rotation), 45f, "der Gefallene faellt nicht um");
        Assert.Greater(fx.LivePieces, 0, "der Koerper verschwindet sofort");

        fx.Step(6f);
        Assert.AreEqual(0, fx.LivePieces, "der Koerper bleibt fuer immer liegen");
        Object.DestroyImmediate(fx.gameObject);
    }

    [Test]
    public void ABlastGrowsThenCollapses()
    {
        var fx = Rig();
        fx.Blast(Vector3.zero, 6f);
        var t = fx.transform.GetChild(0);
        float start = t.localScale.x;

        fx.Step(0.2f);
        float peak = t.localScale.x;
        Assert.Greater(peak, start, "die Explosion waechst nicht");

        fx.Step(0.3f);
        Assert.Less(t.localScale.x, peak, "die Explosion faellt nicht wieder zusammen");
        Object.DestroyImmediate(fx.gameObject);
    }
}
