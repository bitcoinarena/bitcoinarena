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
        yield return new WaitForSeconds(1.5f);

        var panel = Object.FindFirstObjectByType<LoadoutPanel>();
        panel.Auto();
        panel.Confirm();

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
