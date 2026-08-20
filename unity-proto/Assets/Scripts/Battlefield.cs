using UnityEngine;

/// <summary>
/// Ties the live tape to the ground. The frontline is the price chart, and
/// which side of it you stand on decides whether the ground is bull or bear
/// territory.
/// </summary>
public class Battlefield : MonoBehaviour
{
    public MempoolTerrain terrain;
    public MarketFeed market;
    /// <summary>The truck. The armies move aside for it.</summary>
    public Transform courier;

    public PriceHistory History { get; private set; }
    /// <summary>Both armies. Owned here because they live and die by the same tape.</summary>
    public Army Army { get; set; }
    /// <summary>How many riflemen the courier has ridden down.</summary>
    public int RunDown { get; private set; }

    /// <summary>Simulated price when the live feed has nothing, so the map is never dead.</summary>
    double _simPrice = 63000;
    float _simVel;

    void Awake() => History = new PriceHistory(96);

    void Update()
    {
        double price;
        if (market != null && market.Fresh) price = market.Price;
        else
        {
            // random walk at roughly real volatility, replaced the moment the
            // socket delivers a moving price
            _simVel = _simVel * 0.94f + Random.Range(-1f, 1f) * 12f;
            _simPrice = Mathf.Max(1000f, (float)_simPrice + _simVel * Time.deltaTime * 6f);
            price = _simPrice;
        }
        History.Feed(price, Time.deltaTime);

        if (Army != null)
        {
            // trade flow is the pressure: whichever side the tape favours pushes
            Army.Flow = market != null ? market.Flow : 0f;
            Army.Update(Time.deltaTime);

            // AFTER the step, so nobody is left standing inside the truck at
            // the end of a frame - that is what wedges it in place
            if (courier != null)
            {
                var p = courier.position;
                float heading = courier.eulerAngles.y * Mathf.Deg2Rad;

                // anything under the wheels goes down; the rest is only pushed
                // out of a deep overlap so the truck can never be pinned
                var body = courier.GetComponent<Rigidbody>();
                float speed = body != null ? body.linearVelocity.magnitude : 0f;
                var v = body != null ? body.linearVelocity : Vector3.zero;
                var knock = new Vector2(v.x, v.z).normalized;
                RunDown += Army.RunOver(p.x, p.z, 3.6f, speed, knock);

                Army.ClearPath(p.x, p.z, heading, Time.deltaTime);
            }
        }
    }

    /// <summary>Frontline z at a world x.</summary>
    public float FrontlineZ(float x)
    {
        if (History == null || terrain == null) return 0f;
        return History.FrontlineZ(x, terrain.width, terrain.depth);
    }

    /// <summary>True where the bulls hold the ground.</summary>
    public bool IsBullHeld(float x, float z) => z < FrontlineZ(x);
}
