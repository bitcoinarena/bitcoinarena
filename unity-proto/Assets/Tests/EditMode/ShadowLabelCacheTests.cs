using NUnit.Framework;
using UnityEngine;

// THE COMPOSITE OF THE LABEL CACHE (kanban #266, comment 990): from one coverage mask, text over shadow as one straight-alpha
// texel - blended over black and over white, stored in 8 bits - is the shadow label then the text label blended in that order,
// within 1/255 a channel. (The player's own pixel test, ShadowLabelCache.PixelTest, holds the rendered labels to the same.)
public class ShadowLabelCacheTests
{
    static float Over(float c, float a, float dst) => c * a + (1f - a) * dst;

    [Test]
    public void TextOverShadowFromOneMaskIsTheTwoLabelsWithinOne255th()
    {
        const int w = 23, h = 17;
        var rnd = new System.Random(266);
        var mask = new Color[w * h];
        for (int i = 0; i < mask.Length; i++) { float c = rnd.Next(0, 4) == 0 ? 0f : (float)rnd.NextDouble(); mask[i] = new Color(c, c, c, 1f); }
        foreach (var text in new[] { Color.white, new Color(1f, 0.86f, 0.35f), new Color(1f, 0.45f, 0.40f, 0.8f) })
        {
            var px = ShadowLabelCache.Compose(mask, w, h, text, ShadowLabelCache.ShadowColour, ShadowLabelCache.ShadowOffset);
            for (int y = 0; y < h; y++)
                for (int x = 0; x < w; x++)
                {
                    float ct = mask[y * w + x].r;
                    int sx = x - ShadowLabelCache.ShadowOffset.x, sy = y - ShadowLabelCache.ShadowOffset.y;
                    float cs = sx >= 0 && sy >= 0 ? mask[sy * w + sx].r : 0f;
                    Color32 q = px[y * w + x]; Color s = q;
                    foreach (float bg in new[] { 0f, 1f })
                        for (int ch = 0; ch < 3; ch++)
                        {
                            float twoLabels = Over(text[ch], ct * text.a, Over(ShadowLabelCache.ShadowColour[ch], cs * ShadowLabelCache.ShadowColour.a, bg));
                            float oneTexel = Over(s[ch], s.a, bg);
                            Assert.LessOrEqual(Mathf.Abs(twoLabels - oneTexel), 1f / 255f + 1e-5f, $"({x},{y}) over {bg}, channel {ch}");
                        }
                }
        }
    }
}
