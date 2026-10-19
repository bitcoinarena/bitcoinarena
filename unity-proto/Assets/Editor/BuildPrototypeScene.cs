// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.IO;
using UnityEditor;
using UnityEditor.Animations;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;
using UnityEditor.SceneManagement;
using UnityEngine;
using System.Linq;

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
        // strong, because these have to be picked out against the ground
        boot.bullMaterial = Lit("Bull", new Color(0.24f, 0.78f, 0.32f), 0.45f);
        boot.bearMaterial = Lit("Bear", new Color(0.92f, 0.22f, 0.18f), 0.45f);
        boot.tracerMaterial = Lit("Tracer", new Color(1f, 0.92f, 0.55f), 0.2f);
        boot.flashMaterial = Lit("Flash", new Color(1f, 0.96f, 0.78f), 0.15f);
        boot.blastMaterial = Lit("Blast", new Color(1f, 0.55f, 0.14f), 0.35f);
        // Fire GLOWS. A bright base colour is still just a lit surface; emission
        // is what makes it a light source, and what bloom can catch.
        boot.fireCoreMaterial = Glow("FireCore", new Color(1f, 0.97f, 0.86f), 9f);
        boot.fireMaterial = Glow("Fire", new Color(1f, 0.48f, 0.10f), 5f);
        boot.smokeMaterial = Lit("Smoke", new Color(0.46f, 0.44f, 0.42f), 0.95f);
        boot.debrisMaterial = Lit("Debris", new Color(0.28f, 0.26f, 0.24f), 0.55f);
        boot.dustMaterial = Lit("Dust", new Color(0.72f, 0.66f, 0.56f), 0.95f);
        boot.fireParticleMaterial = FireFlipbookMaterial();
        boot.smokeParticleMaterial = SmokeFlipbookMaterial();

        // Pick up an imported soldier model if one is in the project. Done by
        // search rather than by hand in the inspector, because regenerating the
        // scene would otherwise silently drop the assignment every time.
        // Deliberately NOT assigned: a model referenced by the scene is pulled
        // into the player build, which is the very weight streaming exists to
        // remove. ModelStreamer fetches them at runtime instead.
        boot.soldierPrefab = null;
        boot.tankPrefab = null;
        boot.truckModel = null;
        boot.soldierAnimator = BuildSoldierAnimator();
        // Zero, and it must stay zero. The report of men running backwards was
        // about RETREATING soldiers only - advancing ones were already right,
        // so the model does face its own +Z. Fixing the heading logic AND
        // adding 180 degrees was two corrections for one fault, and the second
        // one turned everybody round.
        boot.soldierYawOffset = 0f;
        boot.tankPrefab = FindPrefab("leopard", "tank", "panzer");
        boot.truckModel = FindPrefab("smalltruck", "industrialsmalltruck", "truck", "lorry", "van");

        // The freight boxes are small and are NOT streamed - they are needed
        // the moment the loading bay opens, which is the first thing the player
        // sees, so they ride in the build.
        // Deliberately NOT assigned: the miner streams in over Addressables
        // like the tank does. A scene reference would drag all of it into the
        // player as well, and it would then ship twice.
        boot.minerModel = null;
        Debug.Log("[BuildPrototypeScene] miner: streamed, not embedded");

        boot.boxPrefab = FindPrefab("box_1_browntape", "box_1", "cardboard", "box");
        Debug.Log(boot.boxPrefab != null
            ? "[BuildPrototypeScene] cardboard boxes: " + AssetDatabase.GetAssetPath(boot.boxPrefab)
            : "[BuildPrototypeScene] no cardboard box model - freight stays cubes");
        Debug.Log($"[BuildPrototypeScene] truck model: " +
                  (boot.truckModel != null ? AssetDatabase.GetAssetPath(boot.truckModel) : "none, using a box"));
        Debug.Log($"[BuildPrototypeScene] tank model: " +
                  (boot.tankPrefab != null ? AssetDatabase.GetAssetPath(boot.tankPrefab) : "none, using boxes"));

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

        boot.postProfile = BuildPostProfile();
        WidenShadows();

        System.IO.Directory.CreateDirectory("Assets/Scenes");
        EditorSceneManager.SaveScene(scene, ScenePath);

        // make it the scene that actually runs
        EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(ScenePath, true) };
        AssetDatabase.SaveAssets();
        Debug.Log($"[BuildPrototypeScene] wrote {ScenePath} and set it as build scene 0");
    }

    /// <summary>
    /// A post-processing profile.
    ///
    /// Without one the scene renders raw linear light straight to the screen:
    /// no tonemapping, no contrast curve, no bloom. Everything lands in the
    /// same narrow middle band and the whole picture reads as washed out, which
    /// no amount of texture work fixes.
    /// </summary>
    static VolumeProfile BuildPostProfile()
    {
        Directory.CreateDirectory("Assets/Settings");
        const string path = "Assets/Settings/BattlefieldPost.asset";
        AssetDatabase.DeleteAsset(path);

        var profile = ScriptableObject.CreateInstance<VolumeProfile>();
        AssetDatabase.CreateAsset(profile, path);

        var tone = profile.Add<Tonemapping>(true);
        tone.mode.overrideState = true;
        tone.mode.value = TonemappingMode.ACES;      // filmic shoulder, deep blacks

        var colour = profile.Add<ColorAdjustments>(true);
        colour.postExposure.overrideState = true; colour.postExposure.value = 0f;
        colour.contrast.overrideState = true; colour.contrast.value = 20f;
        colour.saturation.overrideState = true; colour.saturation.value = 12f;

        var bloom = profile.Add<Bloom>(true);
        bloom.threshold.overrideState = true; bloom.threshold.value = 1.15f;
        bloom.intensity.overrideState = true; bloom.intensity.value = 0.7f;
        bloom.scatter.overrideState = true; bloom.scatter.value = 0.62f;

        var vignette = profile.Add<Vignette>(true);
        vignette.intensity.overrideState = true; vignette.intensity.value = 0.18f;
        vignette.smoothness.overrideState = true; vignette.smoothness.value = 0.45f;

        foreach (var c in profile.components) AssetDatabase.AddObjectToAsset(c, profile);
        EditorUtility.SetDirty(profile);
        AssetDatabase.SaveAssets();
        Debug.Log("[BuildPrototypeScene] post profile: ACES, exposure +1.05, contrast +20, bloom 0.7");
        return profile;
    }

    /// <summary>
    /// Shadows reach 50 metres out of the box. On a map 260 metres across that
    /// means the overview has no shadows at all - and shadow is most of what
    /// makes a shape read as a shape.
    /// </summary>
    static void WidenShadows()
    {
        foreach (var guid in AssetDatabase.FindAssets("t:UniversalRenderPipelineAsset"))
        {
            var path = AssetDatabase.GUIDToAssetPath(guid);
            var rp = AssetDatabase.LoadAssetAtPath<UniversalRenderPipelineAsset>(path);
            if (rp == null) continue;
            var so = new SerializedObject(rp);
            so.FindProperty("m_ShadowDistance").floatValue = 260f;
            so.FindProperty("m_ShadowCascadeCount").intValue = 4;
            so.FindProperty("m_MainLightShadowmapResolution").intValue = 2048;
            so.ApplyModifiedProperties();
            EditorUtility.SetDirty(rp);
            Debug.Log($"[BuildPrototypeScene] shadows widened in {Path.GetFileName(path)}");
        }
        AssetDatabase.SaveAssets();
    }

    /// <summary>
    /// Build an animator controller from whatever clips the soldier pack ships.
    ///
    /// The model is a skinned mesh with no controller, so it arrives in its
    /// bind pose and stands there. The clips live as sub-assets inside separate
    /// FBX files, which is why loading the model alone finds nothing.
    ///
    /// Generated as an ASSET rather than assembled at runtime: a controller
    /// only reachable through code is not referenced by the scene, and what the
    /// scene does not reference does not go into the build.
    /// </summary>
    static RuntimeAnimatorController BuildSoldierAnimator()
    {
        var clips = new System.Collections.Generic.Dictionary<string, AnimationClip>();
        foreach (var guid in AssetDatabase.FindAssets("t:AnimationClip"))
        {
            string path = AssetDatabase.GUIDToAssetPath(guid);
            foreach (var sub in AssetDatabase.LoadAllAssetRepresentationsAtPath(path))
            {
                if (sub is not AnimationClip clip) continue;
                string n = (clip.name + " " + Path.GetFileNameWithoutExtension(path)).ToLowerInvariant();
                if (n.Contains("run") || n.Contains("walk")) clips["run"] = clip;
                else if (n.Contains("shoot") || n.Contains("fire") || n.Contains("attack")) clips["shoot"] = clip;
                else if (n.Contains("idle")) clips["idle"] = clip;
            }
        }
        if (clips.Count == 0)
        {
            Debug.Log("[BuildPrototypeScene] no animation clips found - soldiers will stand still");
            return null;
        }
        Debug.Log($"[BuildPrototypeScene] animation clips: {string.Join(", ", clips.Keys)}");

        Directory.CreateDirectory("Assets/Animation");
        const string path2 = "Assets/Animation/Soldier.controller";
        AssetDatabase.DeleteAsset(path2);
        var controller = AnimatorController.CreateAnimatorControllerAtPath(path2);
        controller.AddParameter("Speed", AnimatorControllerParameterType.Float);
        controller.AddParameter("Shoot", AnimatorControllerParameterType.Bool);

        var sm = controller.layers[0].stateMachine;
        var idle = sm.AddState("Idle");
        idle.motion = clips.TryGetValue("idle", out var idleClip) ? idleClip : clips.Values.First();
        sm.defaultState = idle;

        if (clips.TryGetValue("run", out var runClip))
        {
            var run = sm.AddState("Run");
            run.motion = runClip;
            var toRun = idle.AddTransition(run);
            toRun.AddCondition(AnimatorConditionMode.Greater, 0.3f, "Speed");
            toRun.hasExitTime = false; toRun.duration = 0.15f;
            var toIdle = run.AddTransition(idle);
            toIdle.AddCondition(AnimatorConditionMode.Less, 0.3f, "Speed");
            toIdle.hasExitTime = false; toIdle.duration = 0.15f;
        }

        if (clips.TryGetValue("shoot", out var shootClip))
        {
            var shoot = sm.AddState("Shoot");
            shoot.motion = shootClip;
            var toShoot = idle.AddTransition(shoot);
            toShoot.AddCondition(AnimatorConditionMode.If, 0f, "Shoot");
            toShoot.hasExitTime = false; toShoot.duration = 0.08f;
            var back = shoot.AddTransition(idle);
            back.AddCondition(AnimatorConditionMode.IfNot, 0f, "Shoot");
            back.hasExitTime = false; back.duration = 0.12f;
        }

        AssetDatabase.SaveAssets();
        return controller;
    }

    /// <summary>
    /// First model in the project whose name contains one of these words and
    /// which actually has geometry.
    ///
    /// Searches t:GameObject rather than t:Prefab: packs frequently ship a bare
    /// FBX with no prefab at all, which is what the soldier pack does - a
    /// t:Prefab search finds nothing and silently falls back to boxes.
    ///
    /// Animation clips are usually FBX files too, and are skipped: they carry a
    /// rig but no mesh, so picking one up would place invisible soldiers.
    /// </summary>
    static GameObject FindPrefab(params string[] words)
    {
        GameObject best = null;
        foreach (var guid in AssetDatabase.FindAssets("t:GameObject"))
        {
            string path = AssetDatabase.GUIDToAssetPath(guid);
            if (path.ToLowerInvariant().Contains("/animation")) continue;

            string name = System.IO.Path.GetFileNameWithoutExtension(path).ToLowerInvariant();
            bool matches = false;
            foreach (var w in words) if (name.Contains(w)) { matches = true; break; }
            if (!matches) continue;

            var go = AssetDatabase.LoadAssetAtPath<GameObject>(path);
            if (go == null) continue;
            bool hasMesh = go.GetComponentInChildren<MeshRenderer>(true) != null
                        || go.GetComponentInChildren<SkinnedMeshRenderer>(true) != null;
            if (!hasMesh) continue;

            // prefer an actual prefab if the pack ships one
            if (path.EndsWith(".prefab", System.StringComparison.OrdinalIgnoreCase)) return go;
            best ??= go;
        }
        return best;
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

    /// <summary>
    /// A particle material carrying a fire flipbook from whatever VFX pack is
    /// in the project.
    ///
    /// The packs ship their effects as Visual Effect Graph assets, which need
    /// compute shaders and so do not run in WebGL at all - they would look
    /// right in the editor and draw nothing in the build. The flipbook itself
    /// is only a texture, and a classic particle system does run there, so the
    /// artwork survives even though the effect graph cannot.
    /// </summary>
    static Material FireFlipbookMaterial()
    {
        Texture2D sheet = null;
        foreach (var guid in AssetDatabase.FindAssets("t:Texture2D"))
        {
            string path = AssetDatabase.GUIDToAssetPath(guid);
            string name = Path.GetFileNameWithoutExtension(path).ToLowerInvariant();
            // a fire sheet, not the temperature variant, which is a data map
            if (!name.Contains("fireball") || name.Contains("temperature")) continue;
            var tex = AssetDatabase.LoadAssetAtPath<Texture2D>(path);
            if (tex != null) { sheet = tex; break; }
        }
        if (sheet == null)
        {
            Debug.Log("[BuildPrototypeScene] no fire flipbook found - explosions use the built-in spheres");
            return null;
        }

        var shader = Shader.Find("Universal Render Pipeline/Particles/Unlit")
                  ?? Shader.Find("Universal Render Pipeline/Unlit");
        if (shader == null) return null;

        const string path2 = "Assets/Materials/FireFlipbook.mat";
        AssetDatabase.DeleteAsset(path2);
        var mat = new Material(shader);
        AssetDatabase.CreateAsset(mat, path2);
        mat.SetTexture("_BaseMap", sheet);
        mat.SetColor("_BaseColor", Color.white);
        // additive: fire adds light, it does not occlude what is behind it
        mat.SetFloat("_Surface", 1f);                 // transparent
        mat.SetFloat("_Blend", 1f);                   // additive
        mat.SetFloat("_SrcBlend", (float)UnityEngine.Rendering.BlendMode.SrcAlpha);
        mat.SetFloat("_DstBlend", (float)UnityEngine.Rendering.BlendMode.One);
        mat.SetFloat("_ZWrite", 0f);
        mat.renderQueue = (int)UnityEngine.Rendering.RenderQueue.Transparent;
        mat.EnableKeyword("_SURFACE_TYPE_TRANSPARENT");
        mat.EnableKeyword("_ALPHAPREMULTIPLY_ON");
        EditorUtility.SetDirty(mat);
        AssetDatabase.SaveAssets();
        Debug.Log($"[BuildPrototypeScene] fire flipbook: {AssetDatabase.GetAssetPath(sheet)}");
        return mat;
    }

    /// <summary>
    /// The same flipbook, alpha blended and grey, for smoke.
    ///
    /// Additive is right for fire, which adds light, and wrong for smoke, which
    /// blocks it. And a solid sphere is wrong for both: at 17% grey it reads as
    /// a hole in the field rather than as a cloud, which is what kept being
    /// reported as black circles.
    /// </summary>
    static Material SmokeFlipbookMaterial()
    {
        var fire = AssetDatabase.LoadAssetAtPath<Material>("Assets/Materials/FireFlipbook.mat");
        var tex = fire != null ? fire.GetTexture("_BaseMap") : null;
        if (tex == null) return null;

        var shader = Shader.Find("Universal Render Pipeline/Particles/Unlit")
                  ?? Shader.Find("Universal Render Pipeline/Unlit");
        if (shader == null) return null;

        const string path = "Assets/Materials/SmokeFlipbook.mat";
        AssetDatabase.DeleteAsset(path);
        var mat = new Material(shader);
        AssetDatabase.CreateAsset(mat, path);
        mat.SetTexture("_BaseMap", tex);
        mat.SetColor("_BaseColor", new Color(0.55f, 0.53f, 0.50f, 1f));
        mat.SetFloat("_Surface", 1f);                 // transparent
        mat.SetFloat("_Blend", 0f);                   // alpha, not additive
        mat.SetFloat("_SrcBlend", (float)UnityEngine.Rendering.BlendMode.SrcAlpha);
        mat.SetFloat("_DstBlend", (float)UnityEngine.Rendering.BlendMode.OneMinusSrcAlpha);
        mat.SetFloat("_ZWrite", 0f);
        mat.renderQueue = (int)UnityEngine.Rendering.RenderQueue.Transparent;
        mat.EnableKeyword("_SURFACE_TYPE_TRANSPARENT");
        EditorUtility.SetDirty(mat);
        AssetDatabase.SaveAssets();
        Debug.Log("[BuildPrototypeScene] smoke flipbook material built");
        return mat;
    }

    /// <summary>
    /// An emissive material. Set on the ASSET, so the _EMISSION keyword is
    /// there at build time - a keyword enabled only at runtime is one the
    /// stripper has already thrown away.
    /// </summary>
    static Material Glow(string name, Color colour, float strength)
    {
        var mat = Lit(name, colour, 0.2f);
        if (mat == null) return null;
        mat.SetColor("_EmissionColor", colour * strength);
        mat.EnableKeyword("_EMISSION");
        mat.globalIlluminationFlags = MaterialGlobalIlluminationFlags.RealtimeEmissive;
        EditorUtility.SetDirty(mat);
        return mat;
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
