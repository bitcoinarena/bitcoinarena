// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
#if UNITY_EDITOR
using System.IO;
using UnityEditor;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;

/// <summary>
/// Recreates and reassigns the URP pipeline asset if the project has lost it.
///
/// It CAN be lost: neither ProjectSettings/ nor Packages/ nor the .meta files
/// are in git, so a batchmode run that cannot reach the package registry will
/// drop URP from the manifest, and Unity then clears
/// GraphicsSettings.m_CustomRenderPipeline on the way past. Nothing in the
/// repository can put it back, and the symptom is not a missing asset - it is
/// UniversalAdditionalCameraData.cameraStack throwing a NullReferenceException,
/// because camera stacking only exists when URP is the active pipeline. That
/// takes the loading bay overlay down with it.
///
/// Idempotent: run it any time, it only writes what is actually absent.
/// </summary>
public static class RestoreUrpAsset
{
    const string Dir = "Assets/Settings";
    const string PipelinePath = Dir + "/UniversalRenderPipelineAsset.asset";
    const string RendererPath = Dir + "/UniversalRenderer.asset";

    [MenuItem("Tools/Restore URP Asset")]
    public static void Run()
    {
        if (!Directory.Exists(Dir)) { Directory.CreateDirectory(Dir); AssetDatabase.Refresh(); }

        var renderer = AssetDatabase.LoadAssetAtPath<UniversalRendererData>(RendererPath);
        if (renderer == null)
        {
            renderer = ScriptableObject.CreateInstance<UniversalRendererData>();
            AssetDatabase.CreateAsset(renderer, RendererPath);
            Debug.Log("[RestoreUrpAsset] created " + RendererPath);
        }

        var pipeline = AssetDatabase.LoadAssetAtPath<UniversalRenderPipelineAsset>(PipelinePath);
        if (pipeline == null)
        {
            pipeline = UniversalRenderPipelineAsset.Create(renderer);
            AssetDatabase.CreateAsset(pipeline, PipelinePath);
            Debug.Log("[RestoreUrpAsset] created " + PipelinePath);
        }

        // The map is 260 metres across and URP ships a 50 metre shadow
        // distance, which leaves the overview with no shadows at all.
        var so = new SerializedObject(pipeline);
        so.FindProperty("m_ShadowDistance").floatValue = 260f;
        so.FindProperty("m_ShadowCascadeCount").intValue = 4;
        so.FindProperty("m_MainLightShadowmapResolution").intValue = 2048;
        so.ApplyModifiedProperties();

        GraphicsSettings.defaultRenderPipeline = pipeline;
        for (int i = 0; i < QualitySettings.count; i++)
        {
            QualitySettings.SetQualityLevel(i, false);
            QualitySettings.renderPipeline = pipeline;
        }

        AssetDatabase.SaveAssets();
        AssetDatabase.Refresh();
        Debug.Log($"[RestoreUrpAsset] active pipeline is now " +
                  $"{(GraphicsSettings.currentRenderPipeline != null ? GraphicsSettings.currentRenderPipeline.name : "NONE")}");
    }
}
#endif
