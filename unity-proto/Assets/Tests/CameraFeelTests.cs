using System.Collections;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

/// <summary>
/// How the driving FEELS is mostly the camera, and none of it is visible in
/// the code being correct. These check the three things that carry it: the
/// lens opening up with speed, the camera leaning into a corner, and an
/// impact actually throwing it about.
/// </summary>
public class CameraFeelTests
{
    GameObject _boot;
    TruckController _truck;
    ChaseCamera _chase;
    Camera _cam;

    [UnitySetUp]
    public IEnumerator SetUp()
    {
        _boot = new GameObject("Bootstrap");
        _boot.AddComponent<Bootstrap>();
        yield return null;

        // Flat ground. The terrain is the live fee histogram, so how fast the
        // truck gets going and how hard it turns depends on the slope it
        // happens to spawn on - which is what made this read 6 degrees of lean
        // one run and 0.5 the next. These test the camera, not the mempool.
        var ground = Object.FindFirstObjectByType<MempoolTerrain>();
        if (ground != null)
        {
            ground.feeHeight = 0f;
            ground.baseRelief = 0f;
            ground.Build();
        }

        yield return new WaitForSeconds(1.5f);


        // past the title screen: it holds the truck and the ramp until PLAY

        var splash0 = Object.FindFirstObjectByType<SplashScreen>();

        if (splash0 != null && splash0.Showing) splash0.Play();

        yield return null;

        var panel = Object.FindFirstObjectByType<LoadoutPanel>();
        panel.Auto();
        panel.Confirm();

        // Clear the battlefield, for the same reason the tyre tests do.
        //
        // The solo bay is in the MIDDLE of the post office now, so the run out
        // of it goes straight through the war instead of along the empty edge
        // of the map - which is the point, and which means a truck driven at
        // full throttle for six seconds in a camera test gets shot. A wrecked
        // truck stops yawing, the camera stops leaning, and the test reports a
        // camera fault. These check the camera, not the armies.
        foreach (var army in Object.FindObjectsByType<ArmyRenderer>(FindObjectsSortMode.None))
            army.gameObject.SetActive(false);

        _truck = Object.FindFirstObjectByType<TruckController>();
        _chase = Object.FindFirstObjectByType<ChaseCamera>();
        _cam = _chase.GetComponent<Camera>();
    }

    [UnityTearDown]
    public IEnumerator TearDown()
    {
        Time.timeScale = 1f;
        foreach (var go in Object.FindObjectsByType<GameObject>(FindObjectsSortMode.None))
            if (go.transform.parent == null) Object.Destroy(go);
        yield return null;
    }

    [UnityTest]
    public IEnumerator TheLensOpensUpWithSpeed()
    {
        yield return new WaitForSeconds(0.5f);
        float parked = _cam.fieldOfView;

        _truck.useExternalInput = true;
        _truck.externalThrottle = 1f;
        yield return new WaitForSeconds(6f);
        float moving = _cam.fieldOfView;
        _truck.useExternalInput = false;

        Assert.Greater(moving, parked + 3f,
            $"das Sichtfeld bleibt bei {moving:0.0}° stehen (stand: {parked:0.0}°) - " +
            "ohne das wirkt jede Geschwindigkeit gleich");
        Assert.Less(moving, 90f, "das Sichtfeld reisst auf");
    }

    [UnityTest]
    public IEnumerator AnImpactThrowsTheCameraAndItSettlesAgain()
    {
        yield return new WaitForSeconds(0.3f);
        var before = _chase.transform.position;

        _chase.Shake(1.5f);
        yield return null;
        Assert.Greater(_chase.ShakeAmount, 0.5f, "der Stoss kommt nicht an");

        float moved = 0f;
        for (int i = 0; i < 10; i++)
        {
            moved = Mathf.Max(moved, Vector3.Distance(before, _chase.transform.position));
            yield return null;
        }
        Assert.Greater(moved, 0.15f, "die Kamera bewegt sich beim Stoss nicht");

        yield return new WaitForSeconds(1.5f);
        Assert.AreEqual(0f, _chase.ShakeAmount, 0.001f,
            "die Erschuetterung klingt nicht ab - das liest sich als Kamerafehler");
    }

    [UnityTest]
    public IEnumerator TheCameraLeansIntoACorner()
    {
        _truck.useExternalInput = true;
        _truck.externalThrottle = 1f;
        yield return new WaitForSeconds(5f);

        var body = _truck.GetComponent<Rigidbody>();
        Assert.Greater(body.linearVelocity.magnitude, 6f,
            "der Truck faehrt nicht - ohne Fahrt gibt es keine Kurvenlast zu messen");

        float straight = _chase.transform.eulerAngles.z;
        _truck.externalSteer = 1f;

        // The WORST lean over the corner, not a single reading at the end. The
        // lean is eased in and the truck scrubs speed at full lock, so by the
        // time the window closes it is already coming back - which is how this
        // read 0.03 degrees while the camera was visibly leaning 6.
        float lean = 0f;
        for (float t = 0f; t < 1.5f; t += 0.1f)
        {
            yield return new WaitForSeconds(0.1f);
            lean = Mathf.Max(lean,
                Mathf.Abs(Mathf.DeltaAngle(straight, _chase.transform.eulerAngles.z)));
        }
        _truck.useExternalInput = false;

        Assert.Greater(lean, 1.2f,
            $"die Kamera legt sich mit {lean:0.0}° kaum in die Kurve");
        Assert.Less(lean, 20f, "die Kamera kippt weg");
    }

    [UnityTest]
    public IEnumerator RidingSomebodyDownIsFelt()
    {
        var field = Object.FindFirstObjectByType<Battlefield>();
        Assert.IsNotNull(field.chase,
            "das Schlachtfeld kennt die Kamera nicht - Ueberfahren bliebe unbemerkt");
        yield return null;
    }
}
