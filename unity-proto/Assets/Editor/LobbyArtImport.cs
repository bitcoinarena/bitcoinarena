// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using UnityEditor;
using UnityEngine;

/// <summary>
/// THE LOBBY'S HOW-TO ART IS IMPORTED WHOLE (M3.3-34, 2026-09-13 08:58).
///
/// It is a picture with words on it, drawn small on a phone at 2-3x. Unity's
/// defaults would round 1280x720 to a power of two and build mipmaps for a
/// texture that is only ever drawn flat on the title screen, so this one file
/// is imported as GUI art, full size, clamped. ShrinkTextures leaves it alone.
/// </summary>
public class LobbyArtImport : AssetPostprocessor
{
    public const string File = "lobby-how-to-1-2-3-4.jpg";
    /// <summary>the owner's four panels and their whole (2026-09-14 07:55): PNG, white knocked out.</summary>
    public const string Panels = "/lobby-howto";

    void OnPreprocessTexture()
    {
        bool panel = assetPath.Contains(Panels) && assetPath.EndsWith(".png");
        if (!assetPath.EndsWith("/" + File) && !panel) return;
        var t = (TextureImporter)assetImporter;
        t.textureType = TextureImporterType.GUI;
        t.mipmapEnabled = false;
        t.npotScale = TextureImporterNPOTScale.None;
        t.wrapMode = TextureWrapMode.Clamp;
        t.filterMode = FilterMode.Bilinear;
        t.maxTextureSize = 2048;
        if (panel)
        {
            // THE KNOCKED-OUT WHITE IS THE POINT: alpha kept as transparency, and
            // not compressed - words on a picture drawn small on a phone.
            t.alphaIsTransparency = true;
            t.alphaSource = TextureImporterAlphaSource.FromInput;
            t.textureCompression = TextureImporterCompression.Uncompressed;
        }
    }
}
