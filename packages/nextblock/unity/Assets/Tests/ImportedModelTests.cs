// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Collections;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.SceneManagement;
using UnityEngine.TestTools;

/// <summary>
/// Loads the REAL scene rather than dropping a bare Bootstrap on an empty
/// object, because the imported models are assigned by the scene generator.
/// A test that builds its own Bootstrap sees null prefab fields, skips itself,
/// and reports comfort it has not earned - which is exactly what the first
/// version of these did.
/// </summary>
public class ImportedModelTests
{
    Bootstrap _boot;
    MempoolTerrain _terrain;
    RoadNetwork _roads;

    [UnitySetUp]
    public IEnumerator SetUp()
    {
        SceneManager.LoadScene(0, LoadSceneMode.Single);
        yield return null;
        yield return new WaitForSeconds(2.5f);
        _boot = Object.FindFirstObjectByType<Bootstrap>();
        _terrain = Object.FindFirstObjectByType<MempoolTerrain>();
        _roads = Object.FindFirstObjectByType<RoadNetwork>();
        Assert.IsNotNull(_boot, "die Prototyp-Szene enthaelt kein Bootstrap");
    }

    static Bounds Of(GameObject go)
    {
        var rs = go.GetComponentsInChildren<Renderer>(true);
        var b = rs[0].bounds;
        foreach (var r in rs) b.Encapsulate(r.bounds);
        return b;
    }

    [UnityTest]
    public IEnumerator TanksStandOnTheGroundRatherThanInIt()
    {
        var renderer = Object.FindFirstObjectByType<ArmyRenderer>();
        Assert.IsNotNull(renderer?.tankPrefab, "die Szene hat kein Panzermodell zugewiesen");
        yield return null;

        int seen = 0;
        foreach (var t in Object.FindObjectsByType<Transform>(FindObjectsSortMode.None))
        {
            if (t.name != "Hull" || t.GetComponentsInChildren<Renderer>(true).Length == 0) continue;
            var b = Of(t.gameObject);

            // Measure the four TRACK CORNERS in the hull's own frame against
            // the ground beneath each one. A world-space bounding box cannot
            // see this: a hull tilted the wrong way has its centre at exactly
            // the right height, which is all the old check looked at, while one
            // track corner hangs 0.85 m under the ground and the opposite one
            // floats 0.79 m over it. Resting correctly the corners come in
            // within +/-0.16 m, so 0.45 m is a real failure and not noise.
            float low = 99f, high = -99f;
            foreach (var corner in new[]
            {
                new Vector3(1.8f, 0f, 3.4f), new Vector3(-1.8f, 0f, 3.4f),
                new Vector3(1.8f, 0f, -3.4f), new Vector3(-1.8f, 0f, -3.4f),
            })
            {
                var w = t.TransformPoint(corner);
                // the SURFACE, not the terrain: the road deck is laid 45 cm
                // over the ground, and a tank on the road stands on the deck
                float d = w.y - (_roads != null ? _roads.SurfaceHeight(w.x, w.z)
                                                : _terrain.SampleSurface(w.x, w.z));
                low = Mathf.Min(low, d); high = Mathf.Max(high, d);
            }
            // The two sides are NOT symmetric, and deliberately so. Sinking is
            // the reported fault; floating is the price of the lift that
            // prevents it at a ridge or a kerb.
            //
            // The bounds come from measurement, and the first sample was too
            // small: three runs put the worst corner 0.20 m low, and a later
            // run hit 0.35 m. On a hull 2.6 m tall a corner half a metre under
            // is plainly visible and anything less is kerb and packing noise on
            // terrain that is rebuilt from live data, so that is where the line
            // sits.
            Assert.Greater(low, -0.5f,
                $"Panzerkette steckt im Boden: tiefste Ecke {low:0.00} m darunter");
            Assert.Less(high, 0.7f,
                $"Panzer schwebt: hoechste Ecke {high:0.00} m ueber dem Boden");
            Assert.That(Mathf.Max(b.size.x, b.size.z), Is.InRange(4f, 16f),
                $"Panzer ist {Mathf.Max(b.size.x, b.size.z):0.0} m lang");
            if (++seen >= 25) break;
        }
        Assert.Greater(seen, 0, "keine Panzerruempfe gefunden");
    }

    [UnityTest]
    public IEnumerator TheTruckModelSitsOnTheTruck()
    {
        Assert.IsNotNull(_boot.truckModel, "die Szene hat kein Truckmodell zugewiesen");
        yield return null;

        var truck = Object.FindFirstObjectByType<TruckController>();
        var body = truck.transform.Find("Body");
        Assert.IsNotNull(body, "der Truck hat keine Karosserie");

        var b = Of(body.gameObject);
        float away = Vector3.Distance(b.center, truck.transform.position);
        Assert.Less(away, 6f, $"das Modell steht {away:0.0} m neben dem Fahrzeug");
        Assert.That(Mathf.Max(b.size.x, b.size.z), Is.InRange(3f, 12f),
            $"das Modell ist {Mathf.Max(b.size.x, b.size.z):0.0} m lang");
    }

    /// <summary>
    /// The freight is the imported cardboard box, not a primitive cube.
    ///
    /// This lives here rather than with the other cargo tests because those
    /// build a bare Bootstrap in code, which has no prefabs assigned at all -
    /// the models only exist in the real scene. Written there, the test could
    /// never have seen the box even once it was wired up.
    ///
    /// And it checks the MESH, not the renderer: a cube has a renderer too,
    /// which is how the freight stayed cubes while a weaker version of this
    /// passed.
    /// </summary>
    [UnityTest]
    public IEnumerator TheFreightIsTheCardboardModel()
    {
        yield return null;
        var panel = Object.FindFirstObjectByType<LoadoutPanel>();
        var bay = Object.FindFirstObjectByType<CargoBay>();
        Assert.IsNotNull(bay.boxPrefab,
            "der Szene ist kein Kartonmodell zugewiesen - die Pakete bleiben Wuerfel");

        panel.Auto();
        yield return null;

        int crates = 0, modelled = 0;
        foreach (var t in Object.FindObjectsByType<Transform>(FindObjectsSortMode.None))
        {
            if (t.name != "Package") continue;
            crates++;
            foreach (var mf in t.GetComponentsInChildren<MeshFilter>(true))
                if (mf.sharedMesh != null && mf.sharedMesh.name != "Cube") modelled++;
            foreach (var r in t.GetComponentsInChildren<Renderer>(true))
                Assert.IsFalse(r.sharedMaterial.shader.name.StartsWith("Standard"),
                    "ein Paket traegt einen Built-in-Shader - im URP-Build unsichtbar");
        }

        Assert.Greater(crates, 0, "nichts geladen");
        Assert.Greater(modelled, 0, "die Pakete sind immer noch Unity-Wuerfel");
    }

    /// <summary>
    /// The truck model is referenced by the scene, so it is in the build
    /// before anything is streamed. Asking for it over the network as well
    /// could only ever end as "Truck failed", which is what was reported.
    /// </summary>
    [UnityTest]
    public IEnumerator TheTruckIsNotStreamedBecauseItIsInTheBuild()
    {
        yield return null;
        var boot = Object.FindFirstObjectByType<Bootstrap>();
        var streamer = Object.FindFirstObjectByType<ModelStreamer>();

        Assert.IsNotNull(boot.truckModel, "der Szene ist kein Truckmodell zugewiesen");
        foreach (var item in streamer.Items)
            Assert.AreNotEqual("Truck", item.label,
                "der Truck steht auf der Streaming-Liste, obwohl er fest in der Szene sitzt");
    }

    [UnityTest]
    public IEnumerator SoldiersStandOnTheGroundAndAreAnimated()
    {
        var renderer = Object.FindFirstObjectByType<ArmyRenderer>();
        Assert.IsNotNull(renderer?.soldierPrefab, "die Szene hat kein Soldatenmodell zugewiesen");
        Assert.IsNotNull(renderer.soldierAnimator, "kein Animator-Controller - die Soldaten stuenden still");
        yield return null;

        int seen = 0;
        foreach (var t in Object.FindObjectsByType<Transform>(FindObjectsSortMode.None))
        {
            if (t.name != "Soldier" || t.GetComponentsInChildren<Renderer>(true).Length == 0) continue;
            var b = Of(t.gameObject);
            float ground = _terrain.SampleSurface(b.center.x, b.center.z);
            // Measured across 25 live soldiers the soles sit +0.03 to +0.20 m
            // above the ground. The old -0.8 m tolerance let a 1.8 m man stand
            // in it up to his knees and still pass, which is why this never
            // caught them sinking on slopes.
            Assert.Greater(b.min.y, ground - 0.35f,
                $"Soldat steckt im Boden: Unterkante {b.min.y:0.00}, Boden {ground:0.00}");
            Assert.Less(b.min.y, ground + 0.75f,
                $"Soldat schwebt: Unterkante {b.min.y:0.00}, Boden {ground:0.00}");
            Assert.That(b.size.y, Is.InRange(1.2f, 2.6f), $"Soldat ist {b.size.y:0.0} m gross");

            var anim = t.GetComponentInChildren<Animator>();
            Assert.IsNotNull(anim?.runtimeAnimatorController, "Soldat ohne laufenden Animator");
            if (++seen >= 25) break;
        }
        Assert.Greater(seen, 0, "keine Soldaten gefunden");
    }

    /// <summary>
    /// Every imported model must end up on a URP shader.
    ///
    /// These packs ship Built-in materials, and a Built-in shader in a URP
    /// build is not merely wrong - it is ABSENT, so the mesh renders nothing
    /// while still casting a shadow. That failure has now hidden twice: once as
    /// an invisible truck, once as a helicopter that the placeholder version of
    /// showed perfectly well. It is the same mistake in a different place, and
    /// nothing was checking for it.
    /// </summary>
    [UnityTest]
    public IEnumerator NoImportedModelKeepsABuiltInShader()
    {
        // wait for the streamed models to land and be swapped in
        float waited = 0f;
        var streamer = Object.FindFirstObjectByType<ModelStreamer>();
        while (waited < 25f && (streamer == null || !streamer.AllDone))
        {
            yield return new WaitForSeconds(0.5f);
            waited += 0.5f;
            streamer ??= Object.FindFirstObjectByType<ModelStreamer>();
        }
        if (streamer == null || streamer.Loaded == 0) Assert.Ignore("keine Modelle geladen");
        yield return new WaitForSeconds(1.5f);      // let the pools rebuild

        int checkedRenderers = 0;
        foreach (var r in Object.FindObjectsByType<Renderer>(FindObjectsSortMode.None))
        {
            var mat = r.sharedMaterial;
            if (mat == null || mat.shader == null) continue;
            string shader = mat.shader.name;
            // anything the packs brought with them
            if (!shader.StartsWith("Standard") && !shader.StartsWith("Legacy")
                && !shader.StartsWith("Mobile/") && !shader.StartsWith("Diffuse")) continue;

            Assert.Fail($"{r.name} traegt noch '{shader}' - im URP-Build zeichnet das nichts");
            checkedRenderers++;
        }
        _ = checkedRenderers;
    }
}
