// TEXT OVER SHADOW FROM ONE COVERAGE MASK, ON THE GPU (kanban #266, comment 991): the label cache's bake without a read-back.
// _MainTex is the mask target (the label in white over opaque black, at its screen position); _Area its rectangle in UV; the
// shadow's coverage is the mask moved by _Offset pixels (right, down on screen = up in the target's rows). Output is straight
// alpha: c_t over c_s is alpha a_t + (1 - a_t) a_s and colour (c_t a_t + (1 - a_t) c_s a_s) / that alpha. Gamma space, as the
// project blends.
Shader "Hidden/ShadowLabelCompose"
{
    Properties { _MainTex ("Mask", 2D) = "black" {} }
    SubShader
    {
        ZTest Always Cull Off ZWrite Off Blend Off
        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "UnityCG.cginc"
            sampler2D _MainTex; float4 _MainTex_TexelSize;
            float4 _Area;      // x, y, width, height of the label's area in the mask, in UV
            float4 _Text;      // the text colour, straight
            float4 _Shadow;    // the shadow colour, straight
            float4 _Offset;    // the shadow's offset in pixels: x right, y down on screen
            struct v2f { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; };
            v2f vert(appdata_img v) { v2f o; o.pos = UnityObjectToClipPos(v.vertex); o.uv = v.texcoord; return o; }
            float4 frag(v2f i) : SV_Target
            {
                float2 uv = _Area.xy + i.uv * _Area.zw;
                float ct = tex2D(_MainTex, uv).r;
                float2 suv = uv + float2(-_Offset.x, _Offset.y) * _MainTex_TexelSize.xy;
                bool inside = suv.x >= _Area.x && suv.y < _Area.y + _Area.w;
                float cs = inside ? tex2D(_MainTex, suv).r : 0;
                float at = ct * _Text.a, as_ = cs * _Shadow.a;
                float a = at + (1 - at) * as_;
                if (a <= 0) return float4(0, 0, 0, 0);
                float3 c = (_Text.rgb * at + (1 - at) * _Shadow.rgb * as_) / a;
                return float4(c, a);
            }
            ENDCG
        }
    }
}
