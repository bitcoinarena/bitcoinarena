// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using UnityEditor;
using UnityEngine;

/// <summary>
/// The truck mesh has to be readable to work out where its flatbed is.
/// Imported models default to Read/Write off, so mesh.vertices comes back
/// empty and any measurement of the bed silently reads nothing.
/// </summary>
public static class MakeTruckReadable
{
    [MenuItem("Tools/Make truck mesh readable")]
    public static void Run()
    {
        const string path = "Assets/IndustrialSmallTruck/Art/fbx/SmallTruck_1.FBX";
        var importer = AssetImporter.GetAtPath(path) as ModelImporter;
        if (importer == null) { Debug.LogError($"[MakeTruckReadable] no importer at {path}"); return; }
        if (importer.isReadable) { Debug.Log("[MakeTruckReadable] already readable"); return; }
        importer.isReadable = true;
        importer.SaveAndReimport();
        Debug.Log("[MakeTruckReadable] truck mesh is readable now");
    }
}
