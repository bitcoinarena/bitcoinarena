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

    /// <summary>
    /// A shell burst is no longer a single sphere - it is a small version of
    /// the tank explosion - so this measures the whole thing rather than the
    /// first child, which now starts at zero and may not even be lit yet.
    /// </summary>
    [Test]
    public void ABlastGrowsThenCollapses()
    {
        var fx = Rig();
        fx.Blast(Vector3.zero, 6f);

        float Widest()
        {
            float w = 0f;
            foreach (Transform t in fx.transform)
                if (t.gameObject.activeSelf) w = Mathf.Max(w, t.localScale.x);
            return w;
        }

        fx.Step(0.1f);
        float peak = Widest();
        Assert.Greater(peak, 0.5f, "die Explosion waechst nicht");

        for (int i = 0; i < 60; i++) fx.Step(1f / 60f);
        Assert.Less(Widest(), peak, "die Explosion faellt nicht wieder zusammen");
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

/// <summary>
/// A man ridden down has to behave like a man, not like a prop on a rail. The
/// scripted slide it replaced had an identical arc every time and could not
/// bounce, roll, or notice the ground.
/// </summary>
public class RunOverBodyTests
{
    static CombatFx Rig()
    {
        var go = new GameObject("Fx");
        var fx = go.AddComponent<CombatFx>();
        var mat = new Material(Shader.Find("Universal Render Pipeline/Lit") ?? Shader.Find("Standard"));
        fx.tracerMaterial = fx.flashMaterial = fx.blastMaterial = mat;
        fx.bullMaterial = fx.bearMaterial = fx.debrisMaterial = mat;
        fx.fireCoreMaterial = fx.fireMaterial = fx.smokeMaterial = fx.dustMaterial = mat;
        return fx;
    }

    [Test]
    public void AThrownBodyIsHandedToThePhysicsEngine()
    {
        var fx = Rig();
        fx.Body(Vector3.zero, 0f, true, Vector2.right);
        var t = fx.transform.GetChild(0);
        var rb = t.GetComponent<Rigidbody>();
        Assert.IsNotNull(rb, "der Koerper hat keinen Rigidbody - er wird wieder auf einer Bahn geschoben");
        Assert.IsFalse(rb.isKinematic, "der Koerper ist kinematisch, die Physik kann ihn nicht werfen");
        Assert.Greater(rb.linearVelocity.magnitude, 5f, "er bekommt keinen Impuls");
        Assert.Greater(rb.angularVelocity.magnitude, 1f, "er taumelt nicht");
        Object.DestroyImmediate(fx.gameObject);
    }

    [Test]
    public void HeIsThrownTheWayTheTruckWasGoing()
    {
        var fx = Rig();
        fx.Body(Vector3.zero, 0f, true, Vector2.right);
        var rb = fx.transform.GetChild(0).GetComponent<Rigidbody>();
        Assert.Greater(rb.linearVelocity.x, 0f, "er fliegt nicht in Fahrtrichtung");
        Assert.Greater(rb.linearVelocity.y, 0f, "er wird nicht angehoben - er wuerde nur schleifen");
        Object.DestroyImmediate(fx.gameObject);
    }

    [Test]
    public void AManShotWhereHeStoodIsNotThrown()
    {
        var fx = Rig();
        fx.Body(Vector3.zero, 0f, true);          // no knock
        var rb = fx.transform.GetChild(0).GetComponent<Rigidbody>();
        Assert.IsNull(rb, "ein erschossener Soldat wird durch die Gegend geworfen");
        Object.DestroyImmediate(fx.gameObject);
    }

    [Test]
    public void CorpsesDoNotCollideWithTheLivingOrEachOther()
    {
        var fx = Rig();
        fx.Body(Vector3.zero, 0f, true, Vector2.right);
        Assert.IsTrue(Physics.GetIgnoreLayerCollision(CombatFx.CorpseLayer, CombatFx.CorpseLayer),
            "Leichen stossen sich gegenseitig herum");
        Assert.IsTrue(Physics.GetIgnoreLayerCollision(CombatFx.CorpseLayer, ArmyRenderer.UnitLayer),
            "eine Leiche kann den Truck oder einen Panzer schieben");
        Object.DestroyImmediate(fx.gameObject);
    }

    [Test]
    public void ABodyIsParkedBeforeItGoesBackInThePool()
    {
        var fx = Rig();
        fx.Body(Vector3.zero, 0f, true, Vector2.right);
        var rb = fx.transform.GetChild(0).GetComponent<Rigidbody>();
        for (int i = 0; i < 60 * 12; i++) fx.Step(1f / 60f);
        Assert.AreEqual(0, fx.LivePieces);
        Assert.IsTrue(rb.isKinematic,
            "der Koerper haelt seinen letzten Sturz fest und traegt ihn in den naechsten Toten");
        Object.DestroyImmediate(fx.gameObject);
    }
}

/// <summary>
/// A wreck that stops smoking the moment the fireball clears reads as scenery
/// dropped on the field. The fire is what says which hulls are fresh.
/// </summary>
public class BurningWreckTests
{
    static CombatFx Rig()
    {
        var go = new GameObject("Fx");
        var fx = go.AddComponent<CombatFx>();
        var mat = new Material(Shader.Find("Universal Render Pipeline/Lit") ?? Shader.Find("Standard"));
        fx.tracerMaterial = fx.flashMaterial = fx.blastMaterial = mat;
        fx.bullMaterial = fx.bearMaterial = fx.debrisMaterial = mat;
        fx.fireCoreMaterial = fx.fireMaterial = fx.smokeMaterial = fx.dustMaterial = mat;
        return fx;
    }

    [Test]
    public void TheHullKeepsBurningAfterTheBlastHasGone()
    {
        var fx = Rig();
        fx.TankExplosion(Vector3.zero, 0f);

        // well past the fireball, well before the wreck fades
        for (int i = 0; i < 60 * 6; i++) fx.Step(1f / 60f);
        int atSix = fx.LivePieces;

        // it must still be producing something, not sitting inert
        int spawned = 0;
        for (int i = 0; i < 60 * 4; i++)
        {
            int before = fx.LivePieces;
            fx.Step(1f / 60f);
            if (fx.LivePieces > before) spawned += fx.LivePieces - before;
        }
        Assert.Greater(spawned, 0, "das Wrack raucht nicht mehr - es steht nur noch herum");
        Assert.Greater(atSix, 0, "nach sechs Sekunden ist gar nichts mehr da");
        Object.DestroyImmediate(fx.gameObject);
    }

    [Test]
    public void TheFireDiesDownRatherThanBurningForever()
    {
        var fx = Rig();
        fx.TankExplosion(Vector3.zero, 0f);
        for (int i = 0; i < 60 * 60; i++) fx.Step(1f / 60f);
        Assert.AreEqual(0, fx.LivePieces, $"{fx.LivePieces} Teile brennen nach einer Minute noch");
        Object.DestroyImmediate(fx.gameObject);
    }

    [Test]
    public void DebrisIsSplintersRatherThanCrates()
    {
        var fx = Rig();
        fx.TankExplosion(Vector3.zero, 0f);
        foreach (Transform t in fx.transform)
        {
            if (!t.gameObject.activeSelf) continue;
            float biggest = Mathf.Max(t.localScale.x, Mathf.Max(t.localScale.y, t.localScale.z));
            // the fireballs and the wreck are meant to be large; the flying
            // pieces are not, and at 0.8 in near-black they read as black boxes
            if (biggest < 1.5f)
                Assert.Less(biggest, 1.0f, "ein fliegendes Teil ist so gross wie eine Kiste");
        }
        Object.DestroyImmediate(fx.gameObject);
    }
}
