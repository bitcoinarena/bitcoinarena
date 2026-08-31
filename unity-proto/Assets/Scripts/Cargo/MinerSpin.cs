using UnityEngine;

/// <summary>
/// Turns the moving parts of the delivery miner: the cooling fans, the coin
/// under its dome, and the beacon on the uplink mast.
///
/// The model ships these as separately named nodes precisely so they can be
/// driven from here rather than baked into the building. Unscaled time, so the
/// machine keeps running through the death sequence's slow motion - a mining
/// rig does not care that the courier crashed.
/// </summary>
public class MinerSpin : MonoBehaviour
{
    public Transform[] fans;
    public Transform coin;
    public Transform beacon;
    public Renderer beaconLamp;

    [Tooltip("Fan revolutions per minute. Fast enough to blur, slow enough " +
             "not to strobe against the frame rate.")]
    public float fanRpm = 42f;

    [Tooltip("Blades on one fan. Used to keep the blade-passing frequency " +
             "below half the frame rate.")]
    public int bladeCount = 7;

    public float coinRpm = 9f;
    public float coinBobMetres = 1.6f;

    [Tooltip("How deep a fan may be along its axle, in metres. The housings " +
             "are 2.3 m deep and the blade discs are authored at 7.2, so the " +
             "blades otherwise stand proud of their rings on both sides.")]
    public float maxDepth = 3.2f;

    Vector3 _coinHome;
    Vector3[] _axles;
    Quaternion[] _rest;
    float _angle;
    MaterialPropertyBlock _block;

    void Start()
    {
        if (coin != null) _coinHome = coin.localPosition;
        _block = new MaterialPropertyBlock();

        int n = fans != null ? fans.Length : 0;
        _axles = new Vector3[n];
        _rest = new Quaternion[n];
        for (int i = 0; i < n; i++) TrueUp(i);

        // Slow enough that the blades never alias.
        //
        // At 140 rpm with seven blades a blade passes 16.3 times a second, and
        // on a phone rendering at 30 fps that is above Nyquist - so the fan
        // appears to crawl, stop, or run backwards. Held to a quarter of the
        // frame rate it always reads as turning forwards.
        float fps = Mathf.Max(24f, 1f / Mathf.Max(0.001f, Time.smoothDeltaTime));
        float maxRpm = fps * 0.25f / Mathf.Max(1, bladeCount) * 60f;
        fanRpm = Mathf.Min(fanRpm, maxRpm);
    }

    /// <summary>
    /// Everything a fan needs to run true: its axle, its rest pose, and where
    /// the centre of its blade disc actually is.
    ///
    /// The previous version squashed each fan in its own plane to make its
    /// BOUNDING BOX square, on the theory that a fan disc must measure the
    /// same across both in-plane axes. That premise is wrong and it is what
    /// the wobble was. Measured on the import, Fan_01's seven blades sit on a
    /// circle of radius 5.2 centred on the node - the disc is already true.
    /// Its box is 11.0 x 14.5 only because seven blades at 51.4 degrees apart
    /// have no four-fold symmetry, so the corners of the box catch different
    /// parts of different blades. Scaling that box square turned a round fan
    /// into a 31 percent ellipse, and a rotating ellipse is exactly what
    /// "eiernd" looks like.
    ///
    /// What is left is the part that was right: the disc is 7.2 m deep against
    /// a 2.3 m ring, so it is flattened ALONG THE AXLE. That scale commutes
    /// with the spin - it is uniform in the plane the rotation happens in - so
    /// it cannot deform anything as the fan turns.
    ///
    /// Nothing is done about the centre, deliberately. The blades sit on a
    /// circle of radius 5.2 about the node's own origin, so the origin IS the
    /// hub and rotating about it is exact. The bounding box's centre is 10 cm
    /// off it, but that is the asymmetry of seven plates rather than an
    /// eccentric - correcting to it would make a true fan orbit by 10 cm.
    /// </summary>
    void TrueUp(int i)
    {
        var fan = fans[i];
        if (fan == null) { _rest[i] = Quaternion.identity; _axles[i] = Vector3.forward; return; }

        if (!Blades(fan, out var box)) { _axles[i] = Vector3.forward; _rest[i] = fan.localRotation; return; }

        var s = box.size;
        var axle = s.x <= s.y && s.x <= s.z ? Vector3.right
                 : s.y <= s.x && s.y <= s.z ? Vector3.up : Vector3.forward;
        _axles[i] = axle;

        float depth = Vector3.Dot(s, axle);
        if (depth > maxDepth && depth > 0.01f)
        {
            float k = maxDepth / depth;
            fan.localScale = axle == Vector3.right ? new Vector3(k, 1f, 1f)
                           : axle == Vector3.up ? new Vector3(1f, k, 1f)
                           : new Vector3(1f, 1f, k);
        }

        _rest[i] = fan.localRotation;
    }

    /// <summary>The blade assembly's extent, measured in the fan's own frame.</summary>
    static bool Blades(Transform fan, out Bounds box)
    {
        bool any = false;
        box = new Bounds();
        foreach (var r in fan.GetComponentsInChildren<Renderer>(true))
        {
            var mf = r.GetComponent<MeshFilter>();
            if (mf == null || mf.sharedMesh == null) continue;
            var mb = mf.sharedMesh.bounds;
            for (int c = 0; c < 8; c++)
            {
                var corner = new Vector3((c & 1) == 0 ? mb.min.x : mb.max.x,
                                         (c & 2) == 0 ? mb.min.y : mb.max.y,
                                         (c & 4) == 0 ? mb.min.z : mb.max.z);
                var local = fan.InverseTransformPoint(r.transform.TransformPoint(corner));
                if (!any) { box = new Bounds(local, Vector3.zero); any = true; }
                else box.Encapsulate(local);
            }
        }
        return any;
    }

    void Update()
    {
        float t = Time.unscaledTime;

        // Set from absolute time rather than integrated frame by frame: an
        // accumulated angle drifts with the frame rate, so two fans that
        // started together end the session out of step for no reason.
        _angle = Mathf.Repeat(t * fanRpm * 6f, 360f);
        if (fans != null)
            for (int i = 0; i < fans.Length; i++)
                if (fans[i] != null)
                    fans[i].localRotation = _rest[i] * Quaternion.AngleAxis(_angle, _axles[i]);

        if (coin != null)
        {
            coin.Rotate(Vector3.up, coinRpm * 6f * Time.unscaledDeltaTime, Space.Self);
            coin.localPosition = _coinHome + Vector3.up * (Mathf.Sin(t * 0.9f) * coinBobMetres);
        }

        // The beacon pulses rather than turns: a rotating point of light on a
        // 28 metre mast reads as a glitch, a pulsing one reads as a signal.
        if (beaconLamp != null)
        {
            float pulse = 0.45f + 0.55f * Mathf.Abs(Mathf.Sin(t * 1.6f));
            beaconLamp.GetPropertyBlock(_block);
            _block.SetColor("_EmissionColor", new Color(1f, 0.92f, 0.35f) * pulse * 3f);
            beaconLamp.SetPropertyBlock(_block);
        }
    }
}
