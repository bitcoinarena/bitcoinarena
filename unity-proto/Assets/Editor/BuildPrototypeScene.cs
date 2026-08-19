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

        System.IO.Directory.CreateDirectory("Assets/Scenes");
        EditorSceneManager.SaveScene(scene, ScenePath);

        // make it the scene that actually runs
        EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(ScenePath, true) };
        AssetDatabase.SaveAssets();
        Debug.Log($"[BuildPrototypeScene] wrote {ScenePath} and set it as build scene 0");
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
