using System.Collections;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

/// <summary>
/// The death sequence. Mostly this checks the things that are easy to get
/// wrong and impossible to see in a screenshot: that time comes back, and that
/// the respawn still takes five REAL seconds while the world is at a third
/// speed.
/// </summary>
public class WastedSequenceTests
{
    GameObject _boot;
    TruckHealth _health;
    WastedSequence _wasted;

    [UnitySetUp]
    public IEnumerator SetUp()
    {
        _boot = new GameObject("Bootstrap");
        _boot.AddComponent<Bootstrap>();
        yield return new WaitForSeconds(1.5f);
        _health = Object.FindFirstObjectByType<TruckHealth>();
        _wasted = Object.FindFirstObjectByType<WastedSequence>();
    }

    [UnityTearDown]
    public IEnumerator TearDown()
    {
        Time.timeScale = 1f;                 // never leave the suite in slow motion
        foreach (var go in Object.FindObjectsByType<GameObject>(FindObjectsSortMode.None))
            if (go.transform.parent == null) Object.Destroy(go);
        yield return null;
    }

    /// <summary>The truck is protected until it has left the spawn.</summary>
    IEnumerator LeaveSpawn()
    {
        var truck = Object.FindFirstObjectByType<TruckController>();
        truck.transform.position = truck.spawnPosition + new Vector3(25f, 0f, 0f);
        yield return null;
        yield return null;
    }

    [Test]
    public void TheSequenceIsWiredUp()
    {
        Assert.IsNotNull(_wasted, "keine WastedSequence in der Szene");
        Assert.AreSame(_health, _wasted.health, "die Sequenz kennt den Truck nicht");
        Assert.IsNotNull(_wasted.chase, "die Sequenz kennt die Kamera nicht");

        var hud = Object.FindFirstObjectByType<DriveHud>();
        Assert.AreSame(_wasted, hud.wasted, "das HUD zeigt kein WASTED an");
    }

    [UnityTest]
    public IEnumerator TheWorldSlowsDownAndDrains()
    {
        yield return LeaveSpawn();
        _health.WriteOff();
        yield return new WaitForSecondsRealtime(0.9f);

        Assert.Less(Time.timeScale, 0.9f, "die Zeit laeuft beim Tod normal weiter");
        Assert.Greater(_wasted.Intensity, 0.5f, "die Sequenz kommt nicht hoch");
    }

    [UnityTest]
    public IEnumerator TheCameraPullsOffTheWreck()
    {
        yield return LeaveSpawn();
        _health.WriteOff();
        yield return new WaitForSecondsRealtime(0.5f);

        Assert.IsNotNull(_wasted.chase.deathOrbit,
            "die Kamera bleibt am zerstoerten Truck haengen statt abzuruecken");
    }

    /// <summary>
    /// The trap: the respawn wait is in seconds, the world is at a third speed,
    /// and a countdown on scaled time would silently take three times as long.
    /// </summary>
    [UnityTest]
    public IEnumerator FiveSecondsMeansFiveRealSeconds()
    {
        _health.respawnSeconds = 2f;
        yield return LeaveSpawn();
        float t0 = Time.realtimeSinceStartup;

        _health.WriteOff();
        while (_health.IsDestroyed && Time.realtimeSinceStartup - t0 < 8f)
            yield return null;

        float took = Time.realtimeSinceStartup - t0;
        Assert.IsFalse(_health.IsDestroyed, $"kein Respawn nach {took:0.0}s");
        Assert.That(took, Is.InRange(1.5f, 3.5f),
            $"die Wartezeit haengt an der Zeitlupe: {took:0.0}s statt 2s");
    }

    [UnityTest]
    public IEnumerator EverythingComesBackAfterwards()
    {
        _health.respawnSeconds = 1.5f;
        yield return LeaveSpawn();
        _health.WriteOff();

        float t0 = Time.realtimeSinceStartup;
        while (_health.IsDestroyed && Time.realtimeSinceStartup - t0 < 8f)
            yield return null;
        yield return new WaitForSecondsRealtime(0.3f);

        Assert.AreEqual(1f, Time.timeScale, 0.001f, "die Zeitlupe bleibt haengen");
        Assert.AreEqual(0f, _wasted.Intensity, 0.001f, "die Einblendung bleibt stehen");
        Assert.IsNull(_wasted.chase.deathOrbit, "die Kamera kreist weiter um nichts");
    }
}
