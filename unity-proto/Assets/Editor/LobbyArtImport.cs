using UnityEditor;
using UnityEngine;

/// <summary>
/// THE LOBBY'S HOW-TO ART IS IMPORTED WHOLE (M3.3-34, the owner 2026-09-13 08:58).
///
/// It is a picture with words on it, drawn small on a phone at 2-3x. Unity's
/// defaults would round 1280x720 to a power of two and build mipmaps for a
/// texture that is only ever drawn flat on the title screen, so this one file
/// is imported as GUI art, full size, clamped. ShrinkTextures leaves it alone.
/// </summary>
public class LobbyArtImport : AssetPostprocessor
{
    public const string File = "lobby-how-to-1-2-3-4.jpg";

    void OnPreprocessTexture()
    {
        if (!assetPath.EndsWith("/" + File)) return;
        var t = (TextureImporter)assetImporter;
        t.textureType = TextureImporterType.GUI;
        t.mipmapEnabled = false;
        t.npotScale = TextureImporterNPOTScale.None;
        t.wrapMode = TextureWrapMode.Clamp;
        t.filterMode = FilterMode.Bilinear;
        t.maxTextureSize = 2048;
    }
}
