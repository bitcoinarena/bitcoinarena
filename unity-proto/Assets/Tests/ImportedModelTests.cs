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

    [UnitySetUp]
    public IEnumerator SetUp()
    {
        SceneManager.LoadScene(0, LoadSceneMode.Single);
        yield return null;
        yield return new WaitForSeconds(2.5f);
        _boot = Object.FindFirstObjectByType<Bootstrap>();
        _terrain = Object.FindFirstObjectByType<MempoolTerrain>();
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
            float ground = _terrain.SampleSurface(b.center.x, b.center.z);

            Assert.Greater(b.min.y, ground - 1.2f,
                $"Panzer steckt im Boden: Unterkante {b.min.y:0.00}, Boden {ground:0.00}");
            Assert.Less(b.min.y, ground + 2.5f,
                $"Panzer schwebt: Unterkante {b.min.y:0.00}, Boden {ground:0.00}");
            Assert.That(Mathf.Max(b.size.x, b.size.z), Is.InRange(4f, 16f),
                $"Panzer ist {Mathf.Max(b.size.x, b.size.z):0.0} m lang");
            if (++seen >= 6) break;
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
            Assert.Greater(b.min.y, ground - 0.8f,
                $"Soldat steckt im Boden: Unterkante {b.min.y:0.00}, Boden {ground:0.00}");
            Assert.That(b.size.y, Is.InRange(1.2f, 2.6f), $"Soldat ist {b.size.y:0.0} m gross");

            var anim = t.GetComponentInChildren<Animator>();
            Assert.IsNotNull(anim?.runtimeAnimatorController, "Soldat ohne laufenden Animator");
            if (++seen >= 6) break;
        }
        Assert.Greater(seen, 0, "keine Soldaten gefunden");
    }
}
