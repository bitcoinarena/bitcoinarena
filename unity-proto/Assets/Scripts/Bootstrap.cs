using UnityEngine;

/// <summary>
/// Builds the whole prototype scene in code. Unity scene files are YAML full of
/// GUID references, which are painful to author by hand and merge badly; doing
/// it here means the prototype is one script you can read, and it never has a
/// broken reference.
///
/// Drop this on an empty GameObject in an otherwise empty scene and press play.
/// Assign truckModel / tankModel once you have imported real models; without
/// them it builds proxy boxes so the scene runs immediately.
/// </summary>
public class Bootstrap : MonoBehaviour
{
    [Header("Optional imported models")]
    public GameObject truckModel;
    public GameObject wheelModel;

    [Header("Materials (assign URP/Lit with Poly Haven maps)")]
    public Material groundMaterial;
    public Material roadMaterial;
    public Material bodyMaterial;
    public Material wheelMaterial;
    public Material barrierMaterial;
    public Material bullMaterial;
    public Material bearMaterial;

    [Header("Armies")]
    public int armourPerSide = 11;
    public int infantryPerSide = 90;

    [Header("Sun")]
    public float sunPitch = 42f;
    public float sunYaw = -35f;
    public Color sunColour = new Color(1f, 0.95f, 0.86f);
    public float sunIntensity = 2.2f;

    /// <summary>
    /// How far the road ribbon floats above the terrain. Just enough to beat
    /// z-fighting: the road carries NO collider, so it is a painted stripe
    /// rather than a raised deck. A lifted deck with a vertical edge and no
    /// shoulder is something the truck falls off, which is exactly what it did.
    /// </summary>
    public const float RoadLift = 0.3f;

    MempoolTerrain _terrain;
    public MarketFeed Market { get; private set; }
    public Battlefield Field { get; private set; }
    public RoadNetwork Roads { get; private set; }

    void Start()
    {
        EnsureMaterials();
        BuildLighting();
        _terrain = BuildTerrain();

        // live tape first: the frontline is the price chart, so everything
        // downstream wants it already ticking
        Market = gameObject.AddComponent<MarketFeed>();
        Field = gameObject.AddComponent<Battlefield>();
        Field.terrain = _terrain;
        Field.market = Market;
        BuildRoads();

        // same trap: TerritoryMap binds its texture to the ground material in
        // Awake, so it has to know the renderer before the component exists
        var territoryGo = new GameObject("Territory");
        territoryGo.transform.SetParent(transform, false);
        territoryGo.SetActive(false);
        var territory = territoryGo.AddComponent<TerritoryMap>();
        territory.terrain = _terrain;
        territory.field = Field;
        territory.target = _terrain.GetComponent<MeshRenderer>();
        territoryGo.SetActive(true);
        BuildArmies();
        BuildBoundary(_terrain);
        var truck = BuildTruck(_terrain);
        Field.courier = truck.transform;
        BuildCamera(truck);
        gameObject.AddComponent<TouchControls>();
        var hud = gameObject.AddComponent<DriveHud>();
        hud.truck = truck;
        hud.market = Market;
        hud.field = Field;
    }

    /// <summary>
    /// Fill in any material the scene did not supply.
    ///
    /// Dropping this component on an empty object is the documented way to run
    /// the prototype, and an unassigned slot falls back to Unity's default
    /// material - a Built-in shader that does not exist in a URP build, so
    /// everything renders magenta. The URP/Lit shader is already referenced by
    /// the scene's material assets, so asking for it here cannot be stripped.
    /// </summary>
    void EnsureMaterials()
    {
        groundMaterial = Fallback(groundMaterial, new Color(0.34f, 0.31f, 0.27f), 0.92f);
        bullMaterial = Fallback(bullMaterial, new Color(0.24f, 0.52f, 0.28f), 0.55f);
        bearMaterial = Fallback(bearMaterial, new Color(0.62f, 0.22f, 0.20f), 0.55f);
        roadMaterial = Fallback(roadMaterial, new Color(0.12f, 0.12f, 0.13f), 0.72f);
        bodyMaterial = Fallback(bodyMaterial, new Color(0.16f, 0.34f, 0.22f), 0.45f);
        wheelMaterial = Fallback(wheelMaterial, new Color(0.05f, 0.05f, 0.06f), 0.95f);
        barrierMaterial = Fallback(barrierMaterial, new Color(0.58f, 0.55f, 0.50f), 0.85f);
    }

    static Material Fallback(Material assigned, Color colour, float roughness)
    {
        // instancing has to be on or RenderMeshInstanced silently draws nothing
        if (assigned != null) { assigned.enableInstancing = true; return assigned; }
        var shader = Shader.Find("Universal Render Pipeline/Lit") ?? Shader.Find("Standard");
        if (shader == null) { Debug.LogError("[Bootstrap] no usable shader found"); return null; }
        var m = new Material(shader);
        m.SetColor("_BaseColor", colour);
        m.SetFloat("_Smoothness", 1f - roughness);
        m.enableInstancing = true;
        return m;
    }

    void BuildLighting()
    {
        var go = new GameObject("Sun");
        var light = go.AddComponent<Light>();
        light.type = LightType.Directional;
        light.color = sunColour;
        light.intensity = sunIntensity;
        light.shadows = LightShadows.Soft;
        light.shadowBias = 0.02f;
        go.transform.rotation = Quaternion.Euler(sunPitch, sunYaw, 0f);

        RenderSettings.ambientMode = UnityEngine.Rendering.AmbientMode.Skybox;
        RenderSettings.fog = true;
        RenderSettings.fogMode = FogMode.ExponentialSquared;
        RenderSettings.fogDensity = 0.0035f;
        RenderSettings.fogColor = new Color(0.62f, 0.67f, 0.74f);
    }

    MempoolTerrain BuildTerrain()
    {
        var go = new GameObject("MempoolTerrain");
        go.AddComponent<MeshFilter>();
        var mr = go.AddComponent<MeshRenderer>();
        if (groundMaterial != null) mr.sharedMaterial = groundMaterial;
        mr.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.On;
        go.AddComponent<MeshCollider>();
        return go.AddComponent<MempoolTerrain>();
    }

    /// <summary>
    /// All five routes, with their own damage model. Replaces the prototype's
    /// single hand-built ribbon.
    /// </summary>
    void BuildRoads()
    {
        var go = new GameObject("Roads");
        go.transform.SetParent(transform, false);
        // INACTIVE first: AddComponent runs Awake immediately, and RoadNetwork
        // builds all five ribbons there. Assigning the terrain and material
        // afterwards is too late - the roads come out flat at y=0 with no
        // material, buried in the ground.
        go.SetActive(false);
        Roads = go.AddComponent<RoadNetwork>();
        Roads.terrain = _terrain;
        Roads.field = Field;
        Roads.roadMaterial = roadMaterial;
        Roads.lift = RoadLift;
        go.SetActive(true);
    }

    /// <summary>
    /// Walls round the edge of the world.
    ///
    /// The respawn in TruckController is a safety net, not a boundary - being
    /// teleported back to the start because you drove too far is a punishment
    /// for exploring. A wall you can see and bounce off is a map edge.
    ///
    /// They are tall and sunk deep: a truck cresting a fee cliff at speed
    /// arrives at the edge airborne, and a wall it can fly over is not a wall.
    /// </summary>
    void BuildBoundary(MempoolTerrain terrain)
    {
        const float VisibleHeight = 3.2f;   // a kerb you can see, not a fence around the sky
        const float BlockHeight = 26f;      // the part that actually stops a truck
        const float Thickness = 3f;

        var root = new GameObject("Boundary");
        root.transform.SetParent(transform, false);

        float hw = terrain.width * 0.5f, hd = terrain.depth * 0.5f;
        // footprint only: the visual and the blocker each supply their own height
        var sides = new (string name, Vector3 centre, Vector2 footprint)[]
        {
            ("West",  new Vector3(-hw, 0f, 0f), new Vector2(Thickness, terrain.depth + Thickness * 2f)),
            ("East",  new Vector3( hw, 0f, 0f), new Vector2(Thickness, terrain.depth + Thickness * 2f)),
            ("North", new Vector3(0f, 0f, -hd), new Vector2(terrain.width + Thickness * 2f, Thickness)),
            ("South", new Vector3(0f, 0f,  hd), new Vector2(terrain.width + Thickness * 2f, Thickness)),
        };

        foreach (var (name, centre, footprint) in sides)
        {
            float ground = terrain.SampleWorld(centre.x, centre.z);

            // what you see: a low barrier sitting on the ground
            var visual = GameObject.CreatePrimitive(PrimitiveType.Cube);
            visual.name = $"Barrier_{name}";
            visual.transform.SetParent(root.transform, false);
            visual.transform.position = new Vector3(centre.x, ground + VisibleHeight * 0.5f, centre.z);
            visual.transform.localScale = new Vector3(footprint.x, VisibleHeight, footprint.y);
            Destroy(visual.GetComponent<BoxCollider>());
            if (barrierMaterial != null) visual.GetComponent<MeshRenderer>().sharedMaterial = barrierMaterial;

            // what stops you: tall and invisible, so a truck arriving airborne
            // off a fee cliff still cannot clear the edge of the world
            var blocker = new GameObject($"Wall_{name}");
            blocker.transform.SetParent(root.transform, false);
            blocker.transform.position = new Vector3(centre.x, ground + BlockHeight * 0.5f - 6f, centre.z);
            var bc = blocker.AddComponent<BoxCollider>();
            bc.size = new Vector3(footprint.x, BlockHeight, footprint.y);
        }
    }

    /// <summary>Both armies, fed by the same tape that moves the frontline.</summary>
    void BuildArmies()
    {
        Field.Army = new Army(System.Environment.TickCount) { FrontlineAt = Field.FrontlineZ };
        Field.Army.Populate(armourPerSide, infantryPerSide);

        var go = new GameObject("Armies");
        go.transform.SetParent(transform, false);
        go.SetActive(false);                    // wire before Awake, as ever
        var renderer = go.AddComponent<ArmyRenderer>();
        renderer.army = Field.Army;
        renderer.terrain = _terrain;
        renderer.bullMaterial = bullMaterial;
        renderer.bearMaterial = bearMaterial;
        go.SetActive(true);
    }

    TruckController BuildTruck(MempoolTerrain terrain)
    {
        float startX = -terrain.width * 0.44f;
        var root = new GameObject("Truck");
        root.transform.position = new Vector3(startX, terrain.SampleWorld(startX, 0f) + 1.4f, 0f);
        root.transform.rotation = Quaternion.LookRotation(Vector3.right, Vector3.up);

        var rb = root.AddComponent<Rigidbody>();
        rb.mass = 2100f;
        rb.linearDamping = 0.05f;
        rb.angularDamping = 2.5f;
        rb.interpolation = RigidbodyInterpolation.Interpolate;
        rb.collisionDetectionMode = CollisionDetectionMode.ContinuousDynamic;

        // body: the imported model if there is one, a proxy box otherwise
        GameObject body;
        if (truckModel != null)
        {
            body = Instantiate(truckModel, root.transform);
            body.transform.localPosition = Vector3.zero;
        }
        else
        {
            body = GameObject.CreatePrimitive(PrimitiveType.Cube);
            body.name = "BodyProxy";
            body.transform.SetParent(root.transform, false);
            body.transform.localScale = new Vector3(2.4f, 2.2f, 6.2f);
            body.transform.localPosition = new Vector3(0f, 1.0f, 0f);
            StripColliders(body);
            if (bodyMaterial != null) body.GetComponent<MeshRenderer>().sharedMaterial = bodyMaterial;
        }

        // Collision hull, kept separate from the visual body. It has to clear the
        // wheel contact patch by a good margin: the wheels sit at -0.2 with a
        // 0.55 radius, so anything below about -0.1 leaves the chassis dragging
        // on the ground, the suspension unloaded and the tyres spinning freely.
        var hull = root.AddComponent<BoxCollider>();
        hull.size = new Vector3(2.4f, 2.0f, 6.2f);
        hull.center = new Vector3(0f, 0.95f, 0f);

        var controller = root.AddComponent<TruckController>();
        controller.spawnPosition = root.transform.position;
        controller.spawnRotation = root.transform.rotation;
        controller.axles = new[]
        {
            BuildAxle(root.transform, 2.0f, true, false, false),   // front: steers
            BuildAxle(root.transform, -1.8f, false, true, true),   // rear: driven, handbraked
        };
        return controller;
    }

    TruckController.Axle BuildAxle(Transform root, float z, bool steering, bool driven, bool handbraked)
    {
        var axle = new TruckController.Axle { steering = steering, driven = driven, handbraked = handbraked };
        axle.left = BuildWheel(root, new Vector3(-1.15f, -0.2f, z), "L", out axle.leftMesh);
        axle.right = BuildWheel(root, new Vector3(1.15f, -0.2f, z), "R", out axle.rightMesh);
        return axle;
    }

    WheelCollider BuildWheel(Transform root, Vector3 local, string tag, out Transform mesh)
    {
        var go = new GameObject($"Wheel{tag}{local.z:0.0}");
        go.transform.SetParent(root, false);
        go.transform.localPosition = local;

        var wheel = go.AddComponent<WheelCollider>();
        wheel.mass = 70f;
        wheel.radius = 0.55f;
        wheel.suspensionDistance = 0.3f;
        wheel.wheelDampingRate = 1.2f;
        var spring = wheel.suspensionSpring;
        spring.spring = 42000f; spring.damper = 4200f; spring.targetPosition = 0.45f;
        wheel.suspensionSpring = spring;
        var fwd = wheel.forwardFriction; fwd.stiffness = 2.0f; wheel.forwardFriction = fwd;
        var side = wheel.sidewaysFriction; side.stiffness = 2.4f; wheel.sidewaysFriction = side;

        // visual, posed each frame from the collider
        if (wheelModel != null)
        {
            mesh = Instantiate(wheelModel).transform;
        }
        else
        {
            var proxy = GameObject.CreatePrimitive(PrimitiveType.Cylinder);
            proxy.name = go.name + "Mesh";
            proxy.transform.localScale = new Vector3(1.1f, 0.16f, 1.1f);
            // a Unity cylinder stands on its end; a wheel lies on its side
            proxy.transform.rotation = Quaternion.Euler(0f, 0f, 90f);
            StripColliders(proxy);
            if (wheelMaterial != null) proxy.GetComponent<MeshRenderer>().sharedMaterial = wheelMaterial;
            mesh = proxy.transform;
        }
        return wheel;
    }

    /// <summary>
    /// Primitives arrive with a collider, and which one depends on the shape, so
    /// asking for a specific type silently misses. They also have to be disabled
    /// on the spot: Destroy only takes effect at the end of the frame, and until
    /// then these are solid bodies being teleported around by the wheel poser.
    /// </summary>
    static void StripColliders(GameObject go)
    {
        foreach (var c in go.GetComponentsInChildren<Collider>(true)) { c.enabled = false; Destroy(c); }
    }

    void BuildCamera(TruckController truck)
    {
        var go = new GameObject("ChaseCamera");
        var cam = go.AddComponent<Camera>();
        cam.fieldOfView = 62f;
        cam.farClipPlane = 900f;
        go.AddComponent<AudioListener>();
        var chase = go.AddComponent<ChaseCamera>();
        chase.target = truck.transform;
        chase.targetBody = truck.GetComponent<Rigidbody>();
    }
}
