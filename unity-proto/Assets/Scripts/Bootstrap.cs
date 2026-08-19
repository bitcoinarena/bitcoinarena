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

    [Header("Sun")]
    public float sunPitch = 42f;
    public float sunYaw = -35f;
    public Color sunColour = new Color(1f, 0.95f, 0.86f);
    public float sunIntensity = 2.2f;

    MempoolTerrain _terrain;

    void Start()
    {
        BuildLighting();
        _terrain = BuildTerrain();
        BuildRoad(_terrain);
        var truck = BuildTruck(_terrain);
        BuildCamera(truck);
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

    /// <summary>A single road for the prototype: the frontline route, plaza to depot.</summary>
    void BuildRoad(MempoolTerrain terrain)
    {
        const int SEGMENTS = 120;
        const float HALF_WIDTH = 6.5f;
        const float LIFT = 0.45f;

        var verts = new Vector3[(SEGMENTS + 1) * 2];
        var uvs = new Vector2[(SEGMENTS + 1) * 2];
        var tris = new int[SEGMENTS * 6];

        for (int i = 0; i <= SEGMENTS; i++)
        {
            float t = i / (float)SEGMENTS;
            float x = Mathf.Lerp(-terrain.width * 0.46f, terrain.width * 0.46f, t);
            // the road curves, so there is something to steer into
            float z = Mathf.Sin(t * Mathf.PI * 1.6f) * 22f;
            float y = terrain.SampleWorld(x, z) + LIFT;

            float dx = Mathf.Cos(t * Mathf.PI * 1.6f) * 1.6f * Mathf.PI * 22f / terrain.width;
            var normal = new Vector3(-dx, 0f, 1f).normalized;

            verts[i * 2] = new Vector3(x, y, z) - normal * HALF_WIDTH;
            verts[i * 2 + 1] = new Vector3(x, y, z) + normal * HALF_WIDTH;
            uvs[i * 2] = new Vector2(0f, t * SEGMENTS * 0.5f);
            uvs[i * 2 + 1] = new Vector2(1f, t * SEGMENTS * 0.5f);

            if (i < SEGMENTS)
            {
                int b = i * 6, v = i * 2;
                tris[b] = v; tris[b + 1] = v + 2; tris[b + 2] = v + 1;
                tris[b + 3] = v + 1; tris[b + 4] = v + 2; tris[b + 5] = v + 3;
            }
        }

        var mesh = new Mesh { name = "Road" };
        mesh.vertices = verts; mesh.uv = uvs; mesh.triangles = tris;
        mesh.RecalculateNormals(); mesh.RecalculateTangents(); mesh.RecalculateBounds();

        var go = new GameObject("Road");
        go.AddComponent<MeshFilter>().sharedMesh = mesh;
        var mr = go.AddComponent<MeshRenderer>();
        if (roadMaterial != null) mr.sharedMaterial = roadMaterial;
        go.AddComponent<MeshCollider>().sharedMesh = mesh;
    }

    TruckController BuildTruck(MempoolTerrain terrain)
    {
        float startX = -terrain.width * 0.44f;
        var root = new GameObject("Truck");
        root.transform.position = new Vector3(startX, terrain.SampleWorld(startX, 0f) + 1.6f, 0f);
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
