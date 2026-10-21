// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.IO;
using UnityEditor;
using UnityEngine;

/// <summary>
/// Caps imported texture resolution.
///
/// The build report is unambiguous: 68 MB of the payload is Texture2D, and the
/// tank alone brings eight 2048-square maps for 42 MB of it. Nothing here is
/// ever seen close enough to justify that - the tanks are boxes a few pixels
/// tall from the overview camera, and the ground is viewed from a lorry.
///
/// Capping the IMPORT rather than editing the files keeps the originals intact,
/// so raising the cap later costs one reimport.
///
/// Menu: Tools > BTC Logistics > Shrink Textures
/// </summary>
public static class ShrinkTextures
{
    /// <summary>Vehicles and characters: seen at distance, on a 260 metre map.</summary>
    const int ModelCap = 512;
    /// <summary>Ground and road: tiled underfoot, so they earn more.</summary>
    const int SurfaceCap = 1024;

    [MenuItem("Tools/BTC Logistics/Shrink Textures")]
    public static void Run()
    {
        long before = 0, after = 0;
        int touched = 0;

        foreach (var guid in AssetDatabase.FindAssets("t:Texture2D"))
        {
            string path = AssetDatabase.GUIDToAssetPath(guid);
            if (!path.StartsWith("Assets/")) continue;               // leave packages alone
            // the lobby's how-to art has words on it and is drawn small: whole (LobbyArtImport)
            if (path.EndsWith("/" + LobbyArtImport.File)) continue;

            var importer = AssetImporter.GetAtPath(path) as TextureImporter;
            if (importer == null) continue;

            int cap = path.Contains("/Textures/ground") || path.Contains("/Textures/road")
                ? SurfaceCap : ModelCap;
            // the fire flipbook is a grid of frames: shrink it and every frame
            // loses detail at once
            if (path.ToLowerInvariant().Contains("flipbook")) cap = 1024;

            if (importer.maxTextureSize <= cap) continue;

            before += new FileInfo(path).Length;
            importer.maxTextureSize = cap;
            importer.textureCompression = TextureImporterCompression.Compressed;
            importer.SaveAndReimport();
            after += new FileInfo(path).Length;
            touched++;
            Debug.Log($"[ShrinkTextures] {cap,5} <- {path}");
        }

        Debug.Log($"[ShrinkTextures] capped {touched} textures");
        AssetDatabase.SaveAssets();
    }
}
