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

    Vector3 _coinHome;
    Vector3[] _axles;
    MaterialPropertyBlock _block;

    void Start()
    {
        if (coin != null) _coinHome = coin.localPosition;
        _block = new MaterialPropertyBlock();

        _axles = new Vector3[fans != null ? fans.Length : 0];
        for (int i = 0; i < _axles.Length; i++)
        {
            _axles[i] = AxleOf(fans[i]);
            TrueUp(fans[i], _axles[i]);
        }
        // Slow enough that the blades never alias.
        //
        // The axle and the pivot both measured correct and the fans still
        // looked wrong, which is the giveaway for the wagon-wheel effect
        // rather than a transform bug: at 140 rpm with seven blades a blade
        // passes 16.3 times a second, and on a phone rendering at 30 fps that
        // is above Nyquist - so the fan appears to crawl, stop, or run
        // backwards. Held to a quarter of the frame rate it always reads as
        // turning forwards.
        float fps = Mathf.Max(24f, 1f / Mathf.Max(0.001f, Time.smoothDeltaTime));
        float maxRpm = fps * 0.25f / Mathf.Max(1, bladeCount) * 60f;
        fanRpm = Mathf.Min(fanRpm, maxRpm);
    }

    [Tooltip("How deep a fan may be along its axle, in metres. The housings " +
             "are 4 m deep and the blade discs are authored at 7.2.")]
    public float maxDepth = 3.2f;

    /// <summary>
    /// Makes a fan round, and shallow enough to sit in its housing.
    ///
    /// Measured on the model, Fan_01's blade assembly is 11.00 x 14.46 x 7.23.
    /// A fan disc has to be EQUAL in its two in-plane axes - it is a circle -
    /// and this one is 31% out of round, which is precisely what a wobble
    /// looks like: the blade tips do not describe a circle, so the outline
    /// pulses as it turns however true the axle runs. It is also 7.2 m deep
    /// against a 4 m recess and a 2.3 m ring, so the blades stand proud of the
    /// housing.
    ///
    /// Both are corrected here rather than in the model because the fix is
    /// exact and cheap. The scale is applied ONCE in the fan's local frame and
    /// the rotation runs rigidly on top of it - Unity composes local-to-world
    /// as T*R*S, so the shape is fixed before it is turned and cannot change
    /// with the angle. That is the opposite of scaling the BUILDING
    /// non-uniformly, which sheared every rotated part of it.
    /// </summary>
    void TrueUp(Transform fan, Vector3 axle)
    {
        if (fan == null) return;

        bool any = false; var box = new Bounds();
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
        if (!any) return;

        var size = box.size;
        float a, p1, p2;
        if (axle == Vector3.right) { a = size.x; p1 = size.y; p2 = size.z; }
        else if (axle == Vector3.up) { a = size.y; p1 = size.x; p2 = size.z; }
        else { a = size.z; p1 = size.x; p2 = size.y; }
        if (p1 < 0.01f || p2 < 0.01f || a < 0.01f) return;

        float round = (p1 + p2) * 0.5f;
        float k1 = round / p1, k2 = round / p2;
        float ka = Mathf.Min(1f, maxDepth / a);

        fan.localScale = axle == Vector3.right ? new Vector3(ka, k1, k2)
                       : axle == Vector3.up ? new Vector3(k1, ka, k2)
                       : new Vector3(k1, k2, ka);
    }

    /// <summary>
    /// Which way a fan's axle points, taken from the fan's own geometry.
    ///
    /// Rotating every fan about its local Z was a guess and it was wrong - the
    /// blades wobbled instead of spinning, because the hub is threaded onto a
    /// different axis than the node's local forward. A fan is a disc: it is
    /// much thinner along its axle than across it, so measuring the blades in
    /// the fan's own frame and taking the shortest side finds the axle without
    /// anyone having to reason about how the exporter laid the node out.
    /// </summary>
    static Vector3 AxleOf(Transform fan)
    {
        if (fan == null) return Vector3.forward;

        bool any = false;
        var box = new Bounds();
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
        if (!any) return Vector3.forward;

        var s = box.size;
        if (s.x <= s.y && s.x <= s.z) return Vector3.right;
        if (s.y <= s.x && s.y <= s.z) return Vector3.up;
        return Vector3.forward;
    }

    void Update()
    {
        float t = Time.unscaledTime;
        float dt = Time.unscaledDeltaTime;

        if (fans != null)
            for (int i = 0; i < fans.Length; i++)
                if (fans[i] != null)
                    fans[i].Rotate(_axles[i], fanRpm * 6f * dt, Space.Self);

        if (coin != null)
        {
            coin.Rotate(Vector3.up, coinRpm * 6f * dt, Space.Self);
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
