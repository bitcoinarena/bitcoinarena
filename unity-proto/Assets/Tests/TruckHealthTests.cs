using System.Collections;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

/// <summary>
/// The truck's condition, its destruction and the wait before it is back.
/// These drive the real scene rather than a rig: the parts that broke in this
/// project were always the wiring between components, never the arithmetic.
/// </summary>
public class TruckHealthTests
{
    GameObject _boot;
    TruckController _truck;
    TruckHealth _health;
    Battlefield _field;

    [UnitySetUp]
    public IEnumerator SetUp()
    {
        _boot = new GameObject("Bootstrap");
        _boot.AddComponent<Bootstrap>();
        yield return new WaitForSeconds(1.5f);
        _truck = Object.FindFirstObjectByType<TruckController>();
        _health = Object.FindFirstObjectByType<TruckHealth>();
        _field = Object.FindFirstObjectByType<Battlefield>();
    }

    [UnityTearDown]
    public IEnumerator TearDown()
    {
        foreach (var go in Object.FindObjectsByType<GameObject>(FindObjectsSortMode.None))
            if (go.transform.parent == null) Object.Destroy(go);
        yield return null;
    }

    [Test]
    public void TheTruckStartsWhole()
    {
        Assert.IsNotNull(_health, "der Truck hat keine TruckHealth-Komponente");
        Assert.IsFalse(_health.IsDestroyed);
        Assert.AreEqual(1f, _health.Fraction, 0.001f, "der Truck startet nicht mit vollem Zustand");
    }

    [Test]
    public void TheHudShowsTheCondition()
    {
        var hud = Object.FindFirstObjectByType<DriveHud>();
        Assert.IsNotNull(hud, "kein HUD");
        Assert.AreSame(_health, hud.health, "das HUD kennt den Zustand des Trucks nicht");
    }

    [UnityTest]
    public IEnumerator IncomingFireCostsCondition()
    {
        Assert.IsNotNull(_field?.Army, "keine Armee");
        // through the event the armies actually raise, not through Damage()
        _field.Army.CourierHit.Invoke(30f);
        yield return null;

        Assert.Less(_health.Fraction, 1f, "Beschuss hat dem Truck nichts getan");
        Assert.IsFalse(_health.IsDestroyed, "ein einzelner Treffer sollte ihn nicht zerstoeren");
    }

    [UnityTest]
    public IEnumerator EnoughFireWrecksIt()
    {
        for (int i = 0; i < 12 && !_health.IsDestroyed; i++)
        {
            _field.Army.CourierHit.Invoke(20f);
            yield return null;
        }
        Assert.IsTrue(_health.IsDestroyed, "der Truck haelt unbegrenzt Beschuss aus");
    }

    [UnityTest]
    public IEnumerator ADestroyedTruckBurns()
    {
        var fx = Object.FindFirstObjectByType<CombatFx>();
        Assert.IsNotNull(fx, "keine Effekte");
        int before = fx.LiveCount;

        _health.WriteOff();
        yield return null;

        Assert.Greater(fx.LiveCount, before,
            "beim Zerstoeren des Trucks entsteht kein Wrack und keine Explosion");
    }

    [UnityTest]
    public IEnumerator ItIsBackAtTheSpawnAfterTheWait()
    {
        _health.respawnSeconds = 1.5f;               // the real wait is 5s
        var spawn = _truck.spawnPosition;

        _health.WriteOff();
        yield return new WaitForSeconds(0.4f);
        Assert.IsTrue(_health.IsDestroyed, "der Truck ist sofort wieder da");

        yield return new WaitForSeconds(2f);
        Assert.IsFalse(_health.IsDestroyed, "der Truck kommt nach der Wartezeit nicht zurueck");
        Assert.AreEqual(1f, _health.Fraction, 0.001f, "er kommt beschaedigt zurueck");
        Assert.Less(Vector3.Distance(_truck.transform.position, spawn), 6f,
            "er kommt nicht am Spawnpunkt zurueck");
    }

    [UnityTest]
    public IEnumerator TheArmiesLeaveAWreckAlone()
    {
        _health.respawnSeconds = 30f;
        _health.WriteOff();
        yield return new WaitForSeconds(0.3f);

        Assert.IsNull(_field.Army.Courier,
            "die Armeen schiessen weiter auf einen bereits brennenden Truck");
    }

    /// <summary>
    /// The one the report was actually about: driving into a tank. This runs
    /// the real thing - full throttle down the field until it hits armour.
    /// </summary>
    [UnityTest]
    public IEnumerator CrashingIntoArmourWritesItOff()
    {
        _truck.useExternalInput = true;
        _truck.externalThrottle = 1f;

        for (float t = 0f; t < 12f && !_health.IsDestroyed; t += 0.25f)
            yield return new WaitForSeconds(0.25f);

        _truck.useExternalInput = false;
        Assert.IsTrue(_health.IsDestroyed,
            "der Truck ist mit Vollgas ins Schlachtfeld gefahren und nicht zerstoert worden");
    }
}
