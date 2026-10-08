using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;

/// <summary>
/// THE RENDER COSTS, ONE SWITCH EACH, FROM THE PAGE'S ADDRESS (kanban #266, the owner 2026-10-08: "Auf dem iPhone 16 Pro sind es
/// 25-35 fps. Können wir die FPS noch besser optimieren?"). A phone's GPU cannot be profiled from here, so the player measures:
/// `?post=0` no post-processing (bloom, tonemapping, colour, vignette, FXAA), `?shadows=0` no shadow map, `?hdr=0` no HDR
/// target. Nothing is switched without the parameter; the page's FPS readout names what is off (`?dpr=` is the page's).
/// </summary>
public static class GfxSwitches
{
    public static bool NoPost, NoShadows, NoHdr;
    static bool _read;

    static bool Off(string url, string key) =>
        url.Contains("?" + key + "=0") || url.Contains("&" + key + "=0");

    public static void Read()
    {
        if (_read) return;
        _read = true;
        string url = Application.absoluteURL ?? "";
        NoPost = Off(url, "post"); NoShadows = Off(url, "shadows"); NoHdr = Off(url, "hdr");
        if (GraphicsSettings.currentRenderPipeline is UniversalRenderPipelineAsset urp)
        {
            if (NoShadows) urp.shadowDistance = 0f;
            if (NoHdr) urp.supportsHDR = false;
        }
        if (NoPost || NoShadows || NoHdr)
            Debug.Log($"[gfx] switched off by the address: post={(NoPost ? "off" : "on")} shadows={(NoShadows ? "off" : "on")} hdr={(NoHdr ? "off" : "on")}");
    }

    /// <summary>The camera's share: post-processing and its FXAA.</summary>
    public static void Camera(UniversalAdditionalCameraData urp)
    {
        Read();
        if (!NoPost) return;
        urp.renderPostProcessing = false;
        urp.antialiasing = AntialiasingMode.None;
    }
}
