using System.IO;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

/// <summary>
/// Creates the prototype scene from scratch. Generating it rather than
/// committing a .unity file keeps the repo free of GUID-referenced YAML, and
/// means the scene can never drift out of sync with Bootstrap.
///
/// Editor menu: Tools > BTC Logistics > Build Prototype Scene
/// Batch mode:  -executeMethod BuildPrototypeScene.Run
/// </summary>
public static class BuildPrototypeScene
{
    const string ScenePath = "Assets/Scenes/Prototype.unity";

    [MenuItem("Tools/BTC Logistics/Build Prototype Scene")]
    public static void Run()
    {
        var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

        var go = new GameObject("Bootstrap");
        var boot = go.AddComponent<Bootstrap>();

        // Without these every mesh falls back to Unity's default material, which
        // is a Built-in Standard shader - absent from a URP build, so the whole
        // scene renders magenta. Creating them as assets referenced by the scene
        // also keeps the shader out of the build stripper.
        boot.groundMaterial = Lit("Ground", new Color(0.34f, 0.31f, 0.27f), 0.92f);
        boot.roadMaterial = Lit("Road", new Color(0.12f, 0.12f, 0.13f), 0.72f);
        boot.bodyMaterial = Lit("Body", new Color(0.16f, 0.34f, 0.22f), 0.45f, 0.25f);
        boot.wheelMaterial = Lit("Wheel", new Color(0.05f, 0.05f, 0.06f), 0.95f);
        boot.barrierMaterial = Lit("Barrier", new Color(0.58f, 0.55f, 0.50f), 0.85f);
        boot.bullMaterial = Lit("Bull", new Color(0.20f, 0.62f, 0.28f), 0.5f);
        boot.bearMaterial = Lit("Bear", new Color(0.74f, 0.20f, 0.18f), 0.5f);
        boot.tracerMaterial = Lit("Tracer", new Color(1f, 0.92f, 0.55f), 0.2f);
        boot.flashMaterial = Lit("Flash", new Color(1f, 0.96f, 0.78f), 0.15f);
        boot.blastMaterial = Lit("Blast", new Color(1f, 0.55f, 0.14f), 0.35f);

        // scanned CC0 surfaces from Poly Haven, over the flat colours
        AddDetail(boot.groundMaterial,
                  "Assets/Textures/ground/aerial_ground_rock_diff.jpg",
                  "Assets/Textures/ground/aerial_ground_rock_nor.jpg",
                  new Vector2(34f, 22f), 1.1f);
        // The road's base map is free - it carries no world-scale mask - so the
        // asphalt goes on properly, as albedo and normal, rather than as a
        // detail layer multiplied over a flat colour.
        Surface(boot.roadMaterial,
                "Assets/Textures/road/asphalt_02_diff.jpg",
                "Assets/Textures/road/asphalt_02_nor.jpg");

        System.IO.Directory.CreateDirectory("Assets/Scenes");
        EditorSceneManager.SaveScene(scene, ScenePath);

        // make it the scene that actually runs
        EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(ScenePath, true) };
        AssetDatabase.SaveAssets();
        Debug.Log($"[BuildPrototypeScene] wrote {ScenePath} and set it as build scene 0");
    }

    /// <summary>
    /// Import a Poly Haven map with the right settings. A normal map imported
    /// as a colour texture is not merely wrong, it is unreadable - Unity packs
    /// normals differently - and the mistake looks like bad lighting rather
    /// than a bad import.
    /// </summary>
    static Texture2D Map(string path, bool isNormal, bool srgb)
    {
        var importer = AssetImporter.GetAtPath(path) as TextureImporter;
        if (importer != null)
        {
            var wanted = isNormal ? TextureImporterType.NormalMap : TextureImporterType.Default;
            if (importer.textureType != wanted || importer.sRGBTexture != srgb)
            {
                importer.textureType = wanted;
                importer.sRGBTexture = srgb;
                importer.wrapMode = TextureWrapMode.Repeat;
                importer.SaveAndReimport();
            }
        }
        var tex = AssetDatabase.LoadAssetAtPath<Texture2D>(path);
        if (tex == null) Debug.LogWarning($"[BuildPrototypeScene] missing texture {path}");
        return tex;
    }

    /// <summary>
    /// Hang a scanned surface on a material through the DETAIL slots.
    ///
    /// The base map is already spoken for: the ground carries the territory
    /// texture, which spans the whole world at 0..1 so the frontline appears
    /// exactly once. A tiled photo cannot go there. URP's detail maps have
    /// their own tiling, which is precisely this case - world-scale colour
    /// underneath, scanned grain and relief on top.
    /// </summary>
    static void AddDetail(Material mat, string albedo, string normal, Vector2 tiling, float normalStrength = 1f)
    {
        var a = Map(albedo, false, true);
        var n = Map(normal, true, false);
        if (a == null || n == null) return;

        mat.SetTexture("_DetailAlbedoMap", a);
        mat.SetTextureScale("_DetailAlbedoMap", tiling);
        mat.SetTexture("_DetailNormalMap", n);
        mat.SetTextureScale("_DetailNormalMap", tiling);
        mat.SetFloat("_DetailNormalMapScale", normalStrength);
        // without the keyword the maps are assigned and ignored, and because
        // variants are stripped by what material ASSETS ask for, doing it here
        // is also what keeps it working in a build
        mat.EnableKeyword("_DETAIL_MULX2");
        EditorUtility.SetDirty(mat);
    }

    /// <summary>
    /// Put a scanned surface in the MAIN slots. Tiling is left at 1: the mesh
    /// emits UVs already measured in tile units, so there is exactly one place
    /// where the scale is decided.
    /// </summary>
    static void Surface(Material mat, string albedo, string normal, float normalStrength = 1f)
    {
        var a = Map(albedo, false, true);
        var n = Map(normal, true, false);
        if (a == null || n == null) return;

        mat.SetTexture("_BaseMap", a);
        mat.SetTextureScale("_BaseMap", Vector2.one);
        mat.SetColor("_BaseColor", Color.white);      // let the photo speak
        mat.SetTexture("_BumpMap", n);
        mat.SetTextureScale("_BumpMap", Vector2.one);
        mat.SetFloat("_BumpScale", normalStrength);
        mat.EnableKeyword("_NORMALMAP");
        EditorUtility.SetDirty(mat);
    }

    /// <summary>Create (or refresh) a URP/Lit material asset.</summary>
    static Material Lit(string name, Color colour, float roughness, float metallic = 0f)
    {
        Directory.CreateDirectory("Assets/Materials");
        string path = $"Assets/Materials/{name}.mat";

        var shader = Shader.Find("Universal Render Pipeline/Lit");
        if (shader == null)
        {
            Debug.LogError("[BuildPrototypeScene] URP/Lit shader not found - is this a URP project?");
            return null;
        }

        var mat = AssetDatabase.LoadAssetAtPath<Material>(path);
        if (mat == null) { mat = new Material(shader); AssetDatabase.CreateAsset(mat, path); }
        mat.shader = shader;
        mat.SetColor("_BaseColor", colour);
        mat.SetFloat("_Smoothness", 1f - roughness);
        mat.SetFloat("_Metallic", metallic);
        EditorUtility.SetDirty(mat);
        return mat;
    }
}
