// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Collections;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

/// <summary>
/// The building at the end of the run, and the one way through it.
///
/// The point of replacing the gate with a megastructure is that it is a wall:
/// the freight goes in through the tunnel mouth or it does not go in at all.
/// A gate you can drive around is scenery, and the delivery trigger would then
/// be reachable without ever entering the thing.
/// </summary>
public class MinerGateTests
{
    DeliveryGate _gate;
    TruckController _truck;

    [UnitySetUp]
    public IEnumerator SetUp()
    {
        // The SAVED scene, not a fresh Bootstrap.
        //
        // minerModel is a serialized reference assigned by BuildPrototypeScene,
        // so a Bootstrap created with AddComponent has it null and the building
        // never appears. The collision is checked either way - it no longer
        // depends on the model - but "the miner is there" can only be asked of
        // the scene that actually carries it.
        LogAssert.ignoreFailingMessages = true;
        UnityEngine.SceneManagement.SceneManager.LoadScene(
            0, UnityEngine.SceneManagement.LoadSceneMode.Single);
        yield return null;
        yield return new WaitForSeconds(2.5f);

        // The miner streams in, so it is not there on the first frame.
        for (float t = 0f; t < 25f && GameObject.Find("MinerMegastructure") == null;
             t += Time.deltaTime)
            yield return null;

        var splash = Object.FindFirstObjectByType<SplashScreen>();
        if (splash != null && splash.Showing) splash.Play();
        yield return null;
        _gate = Object.FindFirstObjectByType<DeliveryGate>();
        _truck = Object.FindFirstObjectByType<TruckController>();
        yield return null;
        LogAssert.ignoreFailingMessages = false;
    }

    [UnityTearDown]
    public IEnumerator TearDown()
    {
        Time.timeScale = 1f;
        LogAssert.ignoreFailingMessages = true;
        foreach (var go in Object.FindObjectsByType<GameObject>(FindObjectsSortMode.None))
            if (go.transform.parent == null) Object.Destroy(go);
        yield return null;
        LogAssert.ignoreFailingMessages = false;
    }

    [Test]
    public void TheMinerIsBuiltAndIsHuge()
    {
        var miner = GameObject.Find("MinerMegastructure");
        Assert.IsNotNull(miner, "keine Megastruktur am Ziel - das Modell wurde nicht zugewiesen");
        Assert.IsTrue(miner.transform.rotation.eulerAngles.y > 170f
                   && miner.transform.rotation.eulerAngles.y < 190f,
            "die Megastruktur steht falsch herum - der Truck faehrt hinten an");

        var rs = miner.GetComponentsInChildren<Renderer>(true);
        Assert.Greater(rs.Length, 100, "die Megastruktur hat fast keine Renderer");

        var b = rs[0].bounds;
        foreach (var r in rs) b.Encapsulate(r.bounds);
        // 45 m, and the number has a history worth keeping. The coin sits at
        // the very top and is reparented out of the batched body before this
        // runs, so the static bounds stop below it - and the height factor
        // itself came down to 0.45 because the chase camera pitches 15 degrees
        // down, which caps what fits in frame far more tightly than the model
        // does. See SkylineTests for that arithmetic.
        Assert.Greater(b.size.y, 45f, $"nur {b.size.y:0} m hoch - das ist kein Wahrzeichen");
        Assert.Greater(b.size.z, 110f, $"nur {b.size.z:0} m breit - man kaeme daran vorbei");
    }

    /// <summary>
    /// A ray fired along the road at the height of a truck: clear through the
    /// mouth, blocked everywhere else across the width of the map.
    /// </summary>
    [Test]
    public void OnlyTheTunnelMouthIsOpen()
    {
        float x = _gate.gateX - 60f;
        const float TruckHeight = 3f;

        // Just past the facade, and no further. A 130 m ray runs on to the
        // map's own eastern boundary wall, which sits behind the building -
        // so every lane came back blocked, including the open one, and the
        // test was measuring the edge of the world rather than the miner.
        float reach = _gate.gateX + 8f - x;

        // Fired at truck height ABOVE THE GROUND AT THAT z, not at an absolute
        // altitude: the terrain is mempool relief and rolls, so one fixed y is
        // above the road in one lane and under it in the next.
        var terrain = Object.FindFirstObjectByType<MempoolTerrain>();

        bool Clear(float z, float above)
        {
            float y = terrain.SampleSurface(x, z) + above;
            return !Physics.Raycast(new Vector3(x, y, z), Vector3.right, reach);
        }

        // Off the gate's own trigger width rather than hard-coded metres: the
        // building is scaled, so a fixed +/-30 sat exactly on the scaled edge
        // of a 30 m half-opening and read as blocked.
        float inside = _gate.halfMouth * 0.7f;

        Assert.IsTrue(Clear(0f, TruckHeight), "die Einfahrt ist zu");
        Assert.IsTrue(Clear(-inside, TruckHeight), "die Einfahrt ist links zu");
        Assert.IsTrue(Clear(inside, TruckHeight), "die Einfahrt ist rechts zu");

        // outside the mouth, same height: wall
        foreach (float z in new[] { -75f, -55f, 55f, 75f })
            Assert.IsFalse(Clear(z, TruckHeight),
                $"bei z={z:0} kann man an der Einfahrt vorbeifahren");

        // Over the lintel but under the roof.
        //
        // 60 m was hard-coded when the building was 105 m tall; at 55 m that
        // ray clears the roof entirely and correctly reports open sky. The
        // height comes off the building now: twice the mouth, which is well
        // above the opening and well below the top whatever the scale is.
        var mesh = GameObject.Find("MinerMegastructure");
        var mrs = mesh.GetComponentsInChildren<Renderer>(true);
        var mb = mrs[0].bounds; foreach (var r in mrs) mb.Encapsulate(r.bounds);
        float overLintel = mb.min.y + (mb.size.y * 0.45f);

        Assert.IsFalse(Clear(0f, overLintel),
            $"ueber dem Sturztraeger (bei {overLintel:0} m) ist offen");
    }

    /// <summary>Flat out at the facade beside the mouth stops the truck.</summary>
    [UnityTest]
    public IEnumerator DrivingAtTheFacadeDoesNotGetYouIn()
    {
        var rb = _truck.GetComponent<Rigidbody>();
        rb.position = new Vector3(_gate.gateX - 40f, rb.position.y + 1f, 62f);
        yield return new WaitForSeconds(0.3f);

        _truck.useExternalInput = true;
        _truck.externalThrottle = 1f;
        yield return new WaitForSeconds(4f);
        _truck.useExternalInput = false;

        Assert.Less(rb.position.x, _gate.gateX,
            $"der Truck steht bei x={rb.position.x:0} - er ist durch die Fassade gefahren");
    }
}
