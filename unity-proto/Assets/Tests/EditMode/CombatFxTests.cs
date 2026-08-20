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

/// <summary>
/// A destroyed tank has to look like a destroyed tank. One sphere is a
/// placeholder; this checks the explosion actually has its parts and that none
/// of them leak.
/// </summary>
public class TankExplosionTests
{
    static CombatFx Rig()
    {
        var go = new GameObject("Fx");
        var fx = go.AddComponent<CombatFx>();
        var mat = new Material(Shader.Find("Universal Render Pipeline/Lit") ?? Shader.Find("Standard"));
        fx.tracerMaterial = fx.flashMaterial = fx.blastMaterial = mat;
        fx.bullMaterial = fx.bearMaterial = mat;
        fx.fireCoreMaterial = fx.fireMaterial = fx.smokeMaterial = fx.debrisMaterial = mat;
        return fx;
    }

    [Test]
    public void AnExplosionIsMoreThanOneSphere()
    {
        var fx = Rig();
        fx.TankExplosion(Vector3.zero, 0f);
        Assert.Greater(fx.LivePieces, 20,
            $"nur {fx.LivePieces} Teile - das ist wieder eine einzelne Kugel");
        Object.DestroyImmediate(fx.gameObject);
    }

    [Test]
    public void ItArrivesInStagesRatherThanAllAtOnce()
    {
        var fx = Rig();
        fx.TankExplosion(Vector3.zero, 0f);
        int visible = 0;
        foreach (Transform t in fx.transform) if (t.localScale.sqrMagnitude > 0.0001f) visible++;
        Assert.Less(visible, fx.LivePieces,
            "alles ist im ersten Frame voll aufgeblendet - der Feuerball billowt nicht");
        Object.DestroyImmediate(fx.gameObject);
    }

    [Test]
    public void TheFireGoesOutButTheSmokeOutlivesIt()
    {
        var fx = Rig();
        fx.TankExplosion(Vector3.zero, 0f);
        for (int i = 0; i < 60 * 2; i++) fx.Step(1f / 60f);
        int afterFire = fx.LivePieces;
        Assert.Greater(afterFire, 0, "nach zwei Sekunden ist nichts mehr da - kein Rauch, kein Wrack");
        Object.DestroyImmediate(fx.gameObject);
    }

    [Test]
    public void EverythingClearsEventually()
    {
        var fx = Rig();
        fx.TankExplosion(Vector3.zero, 0f);
        for (int i = 0; i < 60 * 30; i++) fx.Step(1f / 60f);
        Assert.AreEqual(0, fx.LivePieces, $"{fx.LivePieces} Teile haengen fest");
        Object.DestroyImmediate(fx.gameObject);
    }

    [Test]
    public void DebrisFallsAndLandsRatherThanFlyingAway()
    {
        var fx = Rig();
        fx.TankExplosion(new Vector3(0f, 0f, 0f), 0f);
        for (int i = 0; i < 60 * 3; i++) fx.Step(1f / 60f);
        foreach (Transform t in fx.transform)
        {
            if (!t.gameObject.activeSelf) continue;
            Assert.Less(t.position.y, 30f, $"ein Teil ist auf {t.position.y:0} Metern - es faellt nicht zurueck");
        }
        Object.DestroyImmediate(fx.gameObject);
    }

    [Test]
    public void SeveralTanksAtOnceStayWithinTheCap()
    {
        var fx = Rig();
        fx.maxPieces = 120;
        for (int i = 0; i < 20; i++) fx.TankExplosion(new Vector3(i * 8f, 0f, 0f), 0f);
        Assert.LessOrEqual(fx.LivePieces, 120, "die Obergrenze greift bei mehreren Explosionen nicht");
        Object.DestroyImmediate(fx.gameObject);
    }
}
