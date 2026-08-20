using System.Collections;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

/// <summary>
/// WheelCollider rigs fail in a small number of well-known ways: the body sinks
/// through the ground, the suspension never settles, or a tall vehicle rolls
/// onto its roof on the first corner. These check the rig actually holds the
/// truck up and drives it, which is the part that cannot be read off the code.
/// </summary>
public class VehicleTests
{
    GameObject _boot;
    TruckController _truck;
    Rigidbody _rb;

    [UnitySetUp]
    public IEnumerator SetUp()
    {
        _boot = new GameObject("Bootstrap");
        _boot.AddComponent<Bootstrap>();
        // let Start() build the world and the suspension settle
        yield return new WaitForSeconds(1.5f);
        _truck = Object.FindFirstObjectByType<TruckController>();
        _rb = _truck != null ? _truck.GetComponent<Rigidbody>() : null;
    }

    [UnityTearDown]
    public IEnumerator TearDown()
    {
        foreach (var go in Object.FindObjectsByType<GameObject>(FindObjectsSortMode.None))
            if (go.transform.parent == null) Object.Destroy(go);
        yield return null;
    }

    [Test]
    public void SceneBuilds()
    {
        Assert.IsNotNull(_truck, "Bootstrap produced no truck");
        Assert.IsNotNull(Object.FindFirstObjectByType<MempoolTerrain>(), "no terrain");
        Assert.IsNotNull(Object.FindFirstObjectByType<ChaseCamera>(), "no camera");
        Assert.AreEqual(4, Object.FindObjectsByType<WheelCollider>(FindObjectsSortMode.None).Length);
    }

    [UnityTest]
    public IEnumerator TruckRestsOnTheGroundInsteadOfSinking()
    {
        float y0 = _rb.position.y;
        yield return new WaitForSeconds(1.5f);
        float drop = y0 - _rb.position.y;
        Assert.Less(drop, 2.0f, $"the truck sank {drop:0.00} units - suspension or collider is wrong");
        Assert.Less(_rb.linearVelocity.magnitude, 1.5f, "the truck never came to rest");
    }

    [UnityTest]
    public IEnumerator StaysUpright()
    {
        yield return new WaitForSeconds(1.5f);
        float tilt = Vector3.Angle(_truck.transform.up, Vector3.up);
        Assert.Less(tilt, 25f, $"the truck is tilted {tilt:0}deg - centre of mass or wheel layout is wrong");
    }

    [UnityTest]
    public IEnumerator DrivesUnderPower()
    {
        Vector3 from = _rb.position;
        // through the real control path, just with the keyboard swapped out
        _truck.useExternalInput = true;
        _truck.externalThrottle = 1f;
        yield return new WaitForSeconds(3f);
        float travelled = Vector3.Distance(from, _rb.position);
        _truck.useExternalInput = false;
        Assert.Greater(travelled, 5f, $"only travelled {travelled:0.0} units under full power");
    }

    [UnityTest]
    public IEnumerator HandbrakeBreaksTheRearEndLoose()
    {
        _truck.useExternalInput = true;
        _truck.externalThrottle = 1f;
        yield return new WaitForSeconds(6f);          // a drift needs real speed

        _truck.externalSteer = 1f;
        yield return new WaitForSeconds(1f);
        float gripped = 0f;
        for (float t = 0f; t < 0.5f; t += Time.fixedDeltaTime)
        {
            gripped = Mathf.Max(gripped, _truck.Slip);
            yield return new WaitForFixedUpdate();
        }

        // off the power and on the handbrake, the way it is actually done
        _truck.externalThrottle = 0f;
        _truck.externalHandbrake = true;
        float slid = 0f;
        int grounded = 0, samples = 0;
        for (float t = 0f; t < 1.5f; t += Time.fixedDeltaTime)
        {
            slid = Mathf.Max(slid, _truck.Slip);
            foreach (var a in _truck.axles) { if (a.left.isGrounded) grounded++; if (a.right.isGrounded) grounded++; }
            samples++;
            yield return new WaitForFixedUpdate();
        }
        Debug.Log($"DRIFT speed={_rb.linearVelocity.magnitude:0.0} m/s " +
                  $"wheelsOnGround={(grounded / (float)samples):0.00}/4 slip={slid:0.00}");
        _truck.useExternalInput = false;

        Assert.Greater(slid, gripped + 0.5f,
            $"handbrake did not break traction: gripped {gripped:0.00} vs slid {slid:0.00} m/s sideways");
    }

    /// <summary>
    /// The short tests all passed while the truck was quietly building up to
    /// 136 m/s and flying off the map: downforce is applied along -transform.up,
    /// which becomes thrust once the hull rolls past 90 degrees. Three seconds
    /// of throttle never got there. Twenty does.
    /// </summary>
    [UnityTest]
    public IEnumerator StaysOnTheMapUnderSustainedThrottle()
    {
        _truck.useExternalInput = true;
        _truck.externalThrottle = 1f;

        float topSpeed = 0f;
        for (float t = 0f; t < 20f; t += 0.25f)
        {
            topSpeed = Mathf.Max(topSpeed, _rb.linearVelocity.magnitude);
            yield return new WaitForSeconds(0.25f);
        }
        Vector3 p = _rb.position;
        _truck.useExternalInput = false;

        Assert.Less(topSpeed, 45f, $"reached {topSpeed * 3.6f:0} km/h - something is adding energy");
        Assert.Less(Mathf.Abs(p.z), 130f, $"left the map sideways at z={p.z:0}");
        Assert.Greater(p.y, -40f, $"fell out of the world at y={p.y:0}");
    }

    /// <summary>
    /// The whole point of the on-screen pads: a finger on the gas pad has to
    /// drive the truck through exactly the same path the keyboard uses.
    /// </summary>
    [UnityTest]
    public IEnumerator TouchGasDrivesTheTruck()
    {
        var pads = Object.FindFirstObjectByType<TouchControls>();
        Assert.IsNotNull(pads, "the scene has no on-screen controls");
        Vector3 from = _rb.position;

        // a finger in the middle of the gas pad, at the real screen size
        pads.debugPoints = new System.Collections.Generic.List<Vector2>
        {
            TouchPad.RectFor(TouchPad.Pad.Up, Screen.width, Screen.height).center,
        };
        yield return new WaitForSeconds(3f);
        float travelled = Vector3.Distance(from, _rb.position);
        pads.debugPoints = null;

        Assert.Greater(travelled, 5f, $"touch gas moved the truck only {travelled:0.0} units");
    }

    [UnityTest]
    public IEnumerator TouchSteerTurnsTheTruck()
    {
        var pads = Object.FindFirstObjectByType<TouchControls>();
        Assert.IsNotNull(pads, "the scene has no on-screen controls");
        var gas = TouchPad.RectFor(TouchPad.Pad.Up, Screen.width, Screen.height).center;
        var right = TouchPad.RectFor(TouchPad.Pad.Right, Screen.width, Screen.height).center;

        pads.debugPoints = new System.Collections.Generic.List<Vector2> { gas };
        yield return new WaitForSeconds(3f);
        float headingBefore = _truck.transform.eulerAngles.y;

        // two fingers at once, which GUI.Button could never have done
        pads.debugPoints = new System.Collections.Generic.List<Vector2> { gas, right };
        yield return new WaitForSeconds(2.5f);
        float delta = Mathf.DeltaAngle(headingBefore, _truck.transform.eulerAngles.y);
        pads.debugPoints = null;

        Assert.Greater(delta, 5f, $"touch steer turned the truck {delta:0.0} degrees, expected a right turn");
    }
}
