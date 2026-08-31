using System.Collections;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

/// <summary>
/// The building the run starts from: the bay the truck is parked in, the wall
/// that makes the bays the only way out, and the live displays.
/// </summary>
public class PostOfficeTests
{
    PostOffice _post;
    TruckController _truck;

    [UnitySetUp]
    public IEnumerator SetUp()
    {
        LogAssert.ignoreFailingMessages = true;
        UnityEngine.SceneManagement.SceneManager.LoadScene(
            0, UnityEngine.SceneManagement.LoadSceneMode.Single);
        yield return null;
        yield return new WaitForSeconds(2.5f);
        for (float t = 0f; t < 30f && GameObject.Find("MempoolPostOffice") == null;
             t += Time.deltaTime)
            yield return null;
        _post = Object.FindFirstObjectByType<PostOffice>();
        _truck = Object.FindFirstObjectByType<TruckController>();
        yield return null;
        LogAssert.ignoreFailingMessages = false;
    }

    [UnityTearDown]
    public IEnumerator TearDown() { Time.timeScale = 1f; yield return null; }

    /// <summary>
    /// Solo, the player always gets Bay 1 - and has to actually be in it.
    /// </summary>
    [Test]
    public void TheTruckStartsInBayOne()
    {
        Assert.IsNotNull(_post, "kein Post Office in der Szene");
        var bay = _post.BayFor(PostOffice.SoloBay);

        float off = Vector2.Distance(
            new Vector2(bay.x, bay.z),
            new Vector2(_truck.spawnPosition.x, _truck.spawnPosition.z));
        Assert.Less(off, 2f,
            $"der Spawn steht {off:0.0} m neben Bay 1 (Spawn z={_truck.spawnPosition.z:0.0}, " +
            $"Bay z={bay.z:0.0})");

        // and pointing out of it
        Assert.Greater(Vector3.Dot(_truck.spawnRotation * Vector3.forward, Vector3.right), 0.9f,
            "der Truck steht nicht in Fahrtrichtung aus der Bay");
    }

    /// <summary>The bays are on a 6.8 m pitch and Bay 24 is the far one.</summary>
    [Test]
    public void TheBaysAreEvenlySpacedAcrossTheMap()
    {
        float first = _post.BayFor(0).z, second = _post.BayFor(1).z, last = _post.BayFor(23).z;
        Assert.AreEqual(6.8f, second - first, 0.01f, "das Portraster stimmt nicht");
        Assert.AreEqual(156.4f, last - first, 0.1f, "die 24 Bays spannen nicht die Front");
    }

    /// <summary>
    /// The facade is a wall. The building spans the map, so without collision
    /// the start of the map has no boundary at all.
    /// </summary>
    [Test]
    public void OnlyTheBaysLetYouThrough()
    {
        var shell = GameObject.Find("PostOfficeShell");
        Assert.IsNotNull(shell, "keine Fassade am Post Office");
        Assert.Greater(shell.GetComponentsInChildren<BoxCollider>(true).Length, 20,
            "die Fassade hat zu wenige Flaechen fuer 24 Tore");
    }

    /// <summary>Every plate carries live data, and none of it is a placeholder.</summary>
    [UnityTest]
    public IEnumerator TheDisplaysCarryLiveData()
    {
        Assert.IsNotNull(GameObject.Find("MempoolPostOffice"),
            "das Modell ist nicht gestreamt worden");
        yield return new WaitForSeconds(4f);

        int filled = 0;
        foreach (var tm in Object.FindObjectsByType<TextMesh>(FindObjectsSortMode.None))
        {
            if (!tm.name.EndsWith("_text")) continue;
            if (!string.IsNullOrEmpty(tm.text) && tm.text != "—") filled++;
        }
        Assert.Greater(filled, 12,
            $"nur {filled} Anzeigen tragen Daten - Gebuehren, Zaehler und Bloecke fehlen");

        // the goggles wall is built from the same offers the yard is
        var goggles = GameObject.Find("goggles_screen");
        Assert.IsNotNull(goggles, "keine Goggles-Wand");
        int tiles = 0;
        foreach (Transform c in goggles.transform) if (c.name.StartsWith("tile")) tiles++;
        Assert.Greater(tiles, 8, $"nur {tiles} Kacheln auf der Goggles-Wand");
    }

    [UnityTest]
    public IEnumerator InspectModeFliesFreeWithoutStartingTheRun()
    {
        var splash = Object.FindFirstObjectByType<SplashScreen>();
        var spec = Object.FindFirstObjectByType<SpectatorCamera>();
        Assert.IsNotNull(spec, "keine Spectator-Kamera");

        splash.Spectate();
        yield return new WaitForSeconds(0.6f);

        Assert.IsTrue(spec.Active, "der Inspect-Modus ist nicht aktiv");
        Assert.IsTrue(_truck.controlsLocked, "die Runde hat gestartet, statt nur zu schauen");

        var was = spec.transform.position;
        spec.Go(SpectatorCamera.Spot.Miner);
        yield return null;
        Assert.Greater(Vector3.Distance(was, spec.transform.position), 50f,
            "der Sprung zum Miner bewegt die Kamera nicht");
    }
}
