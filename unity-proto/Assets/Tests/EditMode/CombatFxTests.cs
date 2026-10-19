// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
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

        // guns fall silent; everything must clear - long enough for the
        // wrecks to burn out, which is the longest-lived thing on the field
        for (int i = 0; i < 60 * 35; i++) fx.Step(1f / 60f);
        Assert.AreEqual(0, fx.LivePieces, $"{fx.LivePieces} Effekte haengen fest (waehrend des Gefechts {during})");
        Object.DestroyImmediate(fx.gameObject);
    }

    /// <summary>
    /// "Nuke blast: black cube through the road" (2026-09-16 12:38). The debris of a blast is dark
    /// cubes. They must fly out, come down and stay where they came down, on top of the road. On the
    /// old rule a chunk started centred on the road, landed on its first frame, and every chunk that
    /// had flown was pulled back to the blast point the frame after it landed, spinning, with a tilted
    /// corner through the asphalt. Measured on a flat ground at 0 m, so the road is y = 0.
    /// </summary>
    [Test]
    public void BlastDebrisStaysWhereItLandsAndOnTopOfTheRoad()
    {
        var fx = Rig();
        // Debris by its own material: in EditMode Awake has not run, so the pool's pieces carry no mesh
        // to tell a cube from a sphere by.
        fx.debrisMaterial = new Material(fx.blastMaterial);
        const float dt = 1f / 60f;
        float deepest = 0f, biggestJump = 0f, landedMoved = 0f;
        int chunks = 0, landedOnFirstFrame = 0;

        for (int blast = 0; blast < 40; blast++)
        {
            fx.Blast(Vector3.zero, 26f);
            var pieces = new System.Collections.Generic.List<Transform>();
            foreach (Transform c in fx.transform)
                if (c.gameObject.activeSelf && c.GetComponent<MeshRenderer>() is MeshRenderer mr
                    && mr.sharedMaterial == fx.debrisMaterial)
                    pieces.Add(c);
            chunks += pieces.Count;

            var last = new Vector3[pieces.Count];
            var landedAt = new Vector3?[pieces.Count];
            // AT REST IS TWO STILL FRAMES IN A ROW. One frame of no height change also happens at the top
            // of a throw - replayed, in 118 of 200 runs of 120 chunks - and read that as a landing; two
            // in a row cannot, the change differing by g dt^2 = 2.7 mm from one frame to the next.
            var stillFrames = new int[pieces.Count];
            for (int i = 0; i < pieces.Count; i++) last[i] = pieces[i].position;

            for (int f = 0; f < 60 * 3; f++)
            {
                fx.Step(dt);
                for (int i = 0; i < pieces.Count; i++)
                {
                    var t = pieces[i];
                    if (!t.gameObject.activeSelf || t.localScale.x < 1e-4f) continue;
                    var at = t.position;
                    float low = LowestCorner(t);
                    deepest = Mathf.Min(deepest, low);
                    biggestJump = Mathf.Max(biggestJump,
                        Vector2.Distance(new Vector2(at.x, at.z), new Vector2(last[i].x, last[i].z)));
                    stillFrames[i] = f > 0 && Mathf.Abs(at.y - last[i].y) < 1e-5f ? stillFrames[i] + 1 : 0;
                    if (landedAt[i] == null && stillFrames[i] >= 2)
                        landedAt[i] = at;
                    if (landedAt[i] != null)
                        landedMoved = Mathf.Max(landedMoved, Vector2.Distance(
                            new Vector2(at.x, at.z), new Vector2(landedAt[i].Value.x, landedAt[i].Value.z)));
                    if (f == 0 && low < 1e-4f) landedOnFirstFrame++;
                    last[i] = at;
                }
            }
            for (int f = 0; f < 60 * 3; f++) fx.Step(dt);    // clear the field for the next blast
        }

        Debug.Log($"[debris-test] {chunks} chunks from 40 blasts: deepest corner {deepest * 100f:F2} cm below the road, "
                  + $"biggest x/z step in one frame {biggestJump:F3} m, moved after coming to rest {landedMoved:F3} m, "
                  + $"on the road after the first frame {landedOnFirstFrame}");

        Assert.Greater(chunks, 0, "a blast threw no debris - the test measured nothing");
        // Fastest sideways throw is 7 m/s: one frame is 0.117 m.
        Assert.LessOrEqual(biggestJump, 7f * dt + 0.01f,
            $"a chunk jumped {biggestJump:F2} m across the ground in one frame");
        Assert.LessOrEqual(landedMoved, 0.001f, $"a chunk moved {landedMoved:F3} m after it had come to rest");
        Assert.GreaterOrEqual(deepest, -0.001f, $"a chunk stood {-deepest * 100f:F2} cm into the road");
        Object.DestroyImmediate(fx.gameObject);
    }

    /// <summary>The lowest of a unit cube's eight corners, as the transform puts them in the world.</summary>
    static float LowestCorner(Transform t)
    {
        float low = float.MaxValue;
        for (int c = 0; c < 8; c++)
        {
            var corner = new Vector3((c & 1) == 0 ? -0.5f : 0.5f, (c & 2) == 0 ? -0.5f : 0.5f, (c & 4) == 0 ? -0.5f : 0.5f);
            low = Mathf.Min(low, t.TransformPoint(corner).y);
        }
        return low;
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

    // THE DEAD ARE NOT SKINNED: a body from a skinned prefab draws one baked mesh, shared by every body, and
    // keeps its materials - no SkinnedMeshRenderer is left for Unity to skin each frame
    [Test]
    public void ABodyIsAStillMeshNotASkinnedOne()
    {
        var fx = Rig();
        var prefab = new GameObject("SkinnedSoldier");
        var part = new GameObject("Mesh"); part.transform.SetParent(prefab.transform, false);
        var cube = GameObject.CreatePrimitive(PrimitiveType.Cube);
        var smr = part.AddComponent<SkinnedMeshRenderer>();
        smr.sharedMesh = cube.GetComponent<MeshFilter>().sharedMesh;
        smr.sharedMaterial = fx.bullMaterial;
        fx.bodyPrefab = prefab;

        fx.Body(Vector3.zero, 0f, true);
        fx.Body(Vector3.one * 5f, 1f, false);
        Assert.AreEqual(0, fx.GetComponentsInChildren<SkinnedMeshRenderer>(true).Length, "a body is still skinned");
        var still = fx.GetComponentsInChildren<MeshFilter>(true);
        Assert.AreEqual(2, still.Length, "each body draws one mesh");
        Assert.AreSame(still[0].sharedMesh, still[1].sharedMesh, "the still pose is baked once, not per body");
        Assert.Greater(still[0].sharedMesh.vertexCount, 0, "the baked pose is empty");
        foreach (var mr in fx.GetComponentsInChildren<MeshRenderer>(true))
            Assert.IsNotNull(mr.sharedMaterial, "a body lost its material");

        Object.DestroyImmediate(fx.gameObject);
        Object.DestroyImmediate(prefab);
        Object.DestroyImmediate(cube);
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
        // past the wreck's 25 second burn, which outlasts everything else
        for (int i = 0; i < 60 * 35; i++) fx.Step(1f / 60f);
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

/// <summary>
/// Reported from play: bodies rolling metres down a hill, and wreck fire that
/// stops and restarts. Both are failures of settling - one physical, one in
/// how the flame is emitted.
/// </summary>
public class SettlingTests
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
    public void ABodyIsABoxNotABarrel()
    {
        var fx = Rig();
        fx.Body(Vector3.zero, 0f, true, Vector2.right);
        var t = fx.transform.GetChild(0);
        Assert.IsNull(t.GetComponent<CapsuleCollider>(),
            "der Koerper hat eine Kapsel - die rollt den Hang hinunter wie ein Fass");
        Assert.IsNotNull(t.GetComponent<BoxCollider>(), "kein Box-Collider am Koerper");
        Object.DestroyImmediate(fx.gameObject);
    }

    [Test]
    public void ABodyGripsTheGroundAndDoesNotBounce()
    {
        var fx = Rig();
        fx.Body(Vector3.zero, 0f, true, Vector2.right);
        var col = fx.transform.GetChild(0).GetComponent<BoxCollider>();
        Assert.IsNotNull(col.material, "kein Reibungsmaterial - er rutscht jeden Hang hinunter");
        Assert.Greater(col.material.dynamicFriction, 0.7f, "zu glatt");
        Assert.AreEqual(0f, col.material.bounciness, 0.01f, "eine Leiche darf nicht huepfen");
        Object.DestroyImmediate(fx.gameObject);
    }

    [Test]
    public void ABodyIsHeavilyDampedSoItStopsTumbling()
    {
        var fx = Rig();
        fx.Body(Vector3.zero, 0f, true, Vector2.right);
        var rb = fx.transform.GetChild(0).GetComponent<Rigidbody>();
        Assert.Greater(rb.angularDamping, 3f, "er dreht sich endlos weiter");
        Assert.Less(rb.angularVelocity.magnitude, 12f, "er wird wie ein Rad angeworfen");
        Object.DestroyImmediate(fx.gameObject);
    }

    [Test]
    public void TheWreckFireBeatsSteadilyRatherThanFlickering()
    {
        var fx = Rig();
        fx.TankExplosion(Vector3.zero, 0f);
        for (int i = 0; i < 60 * 4; i++) fx.Step(1f / 60f);   // past the blast

        // Counted on TotalSpawned, not on the live count: while pieces retire
        // as fast as they appear the live count does not move, so it cannot
        // tell a steady fire from one that has gone out.
        int silentWindows = 0;
        for (int w = 0; w < 12; w++)
        {
            int before = fx.TotalSpawned;
            for (int i = 0; i < 30; i++) fx.Step(1f / 60f);
            if (fx.TotalSpawned == before) silentWindows++;
        }
        Assert.LessOrEqual(silentWindows, 2,
            $"{silentWindows} von 12 halben Sekunden ohne Feuer - es flackert an und aus");
        Object.DestroyImmediate(fx.gameObject);
    }
}
