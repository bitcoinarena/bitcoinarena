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

    [Tooltip("Optional. When set, the armies stop shooting at the truck while " +
             "it is burning, and hits are routed into its condition.")]
    public TruckHealth health;

    public PriceHistory History { get; private set; }
    /// <summary>Both armies. Owned here because they live and die by the same tape.</summary>
    public Army Army { get; set; }
    /// <summary>How many riflemen the courier has ridden down.</summary>
    public int RunDown { get; private set; }

    /// <summary>Simulated price when the live feed has nothing, so the map is never dead.</summary>
    double _simPrice = 63000;
    float _simVel;

    [Header("Air support")]
    [Tooltip("Seconds between sorties, per side. Rare enough that one is an event.")]
    public float sortieSeconds = 17f;

    float _sortieBull, _sortieBear;

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

            // Where the gauntlet is. A wrecked truck is not a target - it is
            // already burning, and shooting it would keep it "dying" through
            // the whole respawn wait.
            bool alive = courier != null &&
                         (health == null || (!health.IsDestroyed && !health.IsInvulnerable));
            Army.Courier = alive
                ? new Vector2(courier.position.x, courier.position.z)
                : (Vector2?)null;

            Army.Update(Time.deltaTime);
            LaunchSorties(Time.deltaTime);

            // AFTER the step, so nobody is left standing inside the truck at
            // the end of a frame - that is what wedges it in place
            if (courier != null && (health == null || !health.IsDestroyed))
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

    /// <summary>
    /// Send gunships out.
    ///
    /// Sparse on purpose: a helicopter carries the heaviest thing in the game,
    /// and one every twenty-odd seconds per side is an event you look up for.
    /// Constant air cover would just be weather.
    /// </summary>
    void LaunchSorties(float dt)
    {
        _sortieBull -= dt;
        _sortieBear -= dt;
        if (_sortieBull <= 0f)
        {
            _sortieBull = sortieSeconds * Random.Range(0.7f, 1.4f);
            Army.SendHelicopter(Army.Side.Bull);
            var h = Army.Helicopters[Army.Helicopters.Count - 1];
            Debug.Log($"[Sortie] bull at x={h.x:0} y={h.y:0} z={h.z:0}, airborne={Army.Helicopters.Count}");
        }
        if (_sortieBear <= 0f)
        {
            _sortieBear = sortieSeconds * Random.Range(0.7f, 1.4f);
            Army.SendHelicopter(Army.Side.Bear);
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
