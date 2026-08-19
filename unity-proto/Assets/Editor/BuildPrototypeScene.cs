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
        go.AddComponent<Bootstrap>();

        System.IO.Directory.CreateDirectory("Assets/Scenes");
        EditorSceneManager.SaveScene(scene, ScenePath);

        // make it the scene that actually runs
        EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(ScenePath, true) };
        AssetDatabase.SaveAssets();
        Debug.Log($"[BuildPrototypeScene] wrote {ScenePath} and set it as build scene 0");
    }
}
