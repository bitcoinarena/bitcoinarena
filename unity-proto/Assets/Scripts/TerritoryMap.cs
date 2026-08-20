using UnityEngine;

/// <summary>
/// Paints the ground by who holds it: green below the frontline, red above.
///
/// Done as a texture rather than vertex colours because URP/Lit ignores vertex
/// colour in its Base Map - a texture needs no custom shader, and the terrain
/// mesh already spans the world, so one 0..1 UV set maps it exactly.
/// </summary>
public class TerritoryMap : MonoBehaviour
{
    public MempoolTerrain terrain;
    public Battlefield field;
    public MeshRenderer target;

    [Tooltip("Seconds between repaints. The seam drifts slowly.")]
    public float refreshSeconds = 0.35f;

    public const int Width = 192;
    public const int Height = 128;

    // Muted on purpose. The ground says WHOSE it is; the units are what you
    // have to pick out of it, and a saturated red tank on saturated red ground
    // is invisible. Held apart enough to read, not enough to compete.
    static readonly Color Bull = new Color(0.30f, 0.40f, 0.27f);
    static readonly Color Bear = new Color(0.44f, 0.30f, 0.27f);
    /// <summary>Churned, colourless ground right where the fighting is.</summary>
    static readonly Color NoMansLand = new Color(0.34f, 0.30f, 0.25f);

    Texture2D _tex;
    Color32[] _px;
    Material _mat;
    float _acc;

    /// <summary>
    /// Ground colour at a distance from the frontline. Pure, so the blend can
    /// be checked without a scene.
    /// </summary>
    public static Color Shade(float distanceFromFront, float noise)
    {
        // 22 units either side is contested and reads as churned earth
        float side = Mathf.Clamp(distanceFromFront / 22f, -1f, 1f);
        Color held = side < 0f ? Bull : Bear;
        Color c = Color.Lerp(NoMansLand, held, Mathf.Abs(side));
        // break up the flat fill so it does not look like painted cardboard
        return c * (0.86f + noise * 0.28f);
    }

    void Awake()
    {
        _tex = new Texture2D(Width, Height, TextureFormat.RGBA32, false)
        {
            wrapMode = TextureWrapMode.Clamp,
            filterMode = FilterMode.Bilinear,
        };
        _px = new Color32[Width * Height];

        Bind();
        Repaint();
    }

    /// <summary>
    /// Bind lazily. Awake runs the instant AddComponent returns, which is
    /// before a caller assembling the scene in code can hand over the renderer
    /// - binding only there left the texture created but never attached, and
    /// the ground stayed a flat brown.
    /// </summary>
    void Bind()
    {
        if (_mat != null || target == null) return;
        _mat = target.material;      // instance, so the .mat asset is not modified
        _mat.SetTexture("_BaseMap", _tex);
        _mat.SetColor("_BaseColor", Color.white);
    }

    /// <summary>The texture the ground is painted with. Exposed so a test can check it is bound.</summary>
    public Texture2D Texture => _tex;
    public bool IsBound => _mat != null && _mat.GetTexture("_BaseMap") == _tex;

    void Update()
    {
        Bind();
        _acc += Time.deltaTime;
        if (_acc < refreshSeconds) return;
        _acc = 0f;
        Repaint();
    }

    void Repaint()
    {
        if (terrain == null || field == null) return;
        float w = terrain.width, d = terrain.depth;

        for (int py = 0; py < Height; py++)
        {
            float v = (py + 0.5f) / Height;
            float z = (v - 0.5f) * d;
            for (int px = 0; px < Width; px++)
            {
                float u = (px + 0.5f) / Width;
                float x = (u - 0.5f) * w;
                float front = field.FrontlineZ(x);
                float n = Mathf.PerlinNoise(u * 26f, v * 18f);
                _px[py * Width + px] = Shade(z - front, n);
            }
        }
        _tex.SetPixels32(_px);
        _tex.Apply(false);
    }
}
