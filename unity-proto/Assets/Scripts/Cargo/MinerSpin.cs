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
    public float fanRpm = 140f;

    public float coinRpm = 9f;
    public float coinBobMetres = 1.6f;

    Vector3 _coinHome;
    MaterialPropertyBlock _block;

    void Start()
    {
        if (coin != null) _coinHome = coin.localPosition;
        _block = new MaterialPropertyBlock();
    }

    void Update()
    {
        float t = Time.unscaledTime;
        float dt = Time.unscaledDeltaTime;

        if (fans != null)
            foreach (var f in fans)
                if (f != null) f.Rotate(Vector3.forward, fanRpm * 6f * dt, Space.Self);

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
