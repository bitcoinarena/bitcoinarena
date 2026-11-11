# #1197 (Daniel 2026-11-06: the Up or Down picture must look very different from Tick Tock's): a market view, no candles.
# One price line across a 15-minute round, the price to beat dashed, the side above tinted Up and below Down, the chance of each side as
# one big bar, and the time left.
import math, random
from PIL import Image, ImageDraw, ImageFont
FD = '/tmp/claude-1000/-home-daniel-marketing/e57274cb-2da0-4b2d-bce8-60829622d86b/scratchpad/fonts/'
F = lambda n, s: ImageFont.truetype(FD + n + '.ttf', s)
S = 2; W, H = 1280 * S, 720 * S
BG = (12, 16, 24); INK = (236, 238, 242); INK2 = (160, 168, 182); INK3 = (98, 108, 124); LINE = (34, 42, 56)
UP = (52, 199, 120); DN = (240, 86, 86); OR = (247, 147, 26)
s = lambda v: int(round(v * S))
im = Image.new('RGB', (W, H), BG); d = ImageDraw.Draw(im, 'RGBA')
# the price path: 9:30 of the window gone, a dip under the line and the climb back above it
random.seed(7)
N = 340; BEAT = 78120.0; pts = []
p = 78121.0
for i in range(N):
    t = i / (N - 1)
    target = 78120 + 6 * math.sin(t * 5.2) - 14 * math.exp(-((t - 0.38) / 0.12) ** 2) + 19 * max(0, t - 0.55) ** 1.2
    p += (target - p) * 0.08 + random.uniform(-0.9, 0.9)
    pts.append(p)
L, T, R, B = 60, 150, 1010, 560
PMIN, PMAX = 78096, 78146
X = lambda i: L + (R - L) * (i / 580)          # the full window is 15 min = 580 steps; we are at step N
Y = lambda v: T + (PMAX - v) / (PMAX - PMIN) * (B - T)
# zones: above the line Up, below Down
d.rectangle((s(L), s(T), s(R), s(Y(BEAT))), fill=UP + (22,))
d.rectangle((s(L), s(Y(BEAT)), s(R), s(B)), fill=DN + (22,))
d.text((s(R - 12), s(T + 16)), 'UP', font=F('SG-Bold', s(26)), fill=UP + (150,), anchor='ra')
d.text((s(R - 12), s(B - 16)), 'DOWN', font=F('SG-Bold', s(26)), fill=DN + (150,), anchor='rd')
# the price to beat
xx = L
while xx < R:
    d.line((s(xx), s(Y(BEAT)), s(min(xx + 9, R)), s(Y(BEAT))), fill=OR, width=s(2)); xx += 16
d.text((s(R - 12), s(Y(BEAT) + 10)), 'price to beat  $78,120.00', font=F('In-Semi', s(15)), fill=OR, anchor='ra')
# the window's end
d.line((s(R), s(T), s(R), s(B)), fill=LINE, width=s(2))
# the line and the area under it
line = [(s(X(i)), s(Y(v))) for i, v in enumerate(pts)]
d.line(line, fill=INK, width=s(3), joint='curve')
lx, ly = line[-1]
d.ellipse((lx - s(7), ly - s(7), lx + s(7), ly + s(7)), fill=UP)
d.ellipse((lx - s(14), ly - s(14), lx + s(14), ly + s(14)), outline=UP + (90,), width=s(2))
# axis labels
for m in (0, 5, 10, 15):
    x = L + (R - L) * m / 15
    d.text((s(x), s(B + 22)), f'20:{m:02d}', font=F('In-Reg', s(15)), fill=INK3, anchor='mm')
# header
d.text((s(60), s(52)), 'Bitcoin Up or Down', font=F('SG-Bold', s(34)), fill=INK, anchor='lm')
d.text((s(60), s(94)), 'Will BTC be higher at 20:15 UTC than at 20:00?', font=F('In-Reg', s(18)), fill=INK2, anchor='lm')
# right column: price now, the clock
cx = 1145
d.text((s(cx), s(170)), 'BTC now', font=F('In-Reg', s(16)), fill=INK2, anchor='mm')
d.text((s(cx), s(204)), f'${pts[-1]:,.2f}', font=F('SG-Bold', s(28)), fill=INK, anchor='mm')
d.text((s(cx), s(238)), f'+${pts[-1] - BEAT:.2f}', font=F('In-Semi', s(18)), fill=UP, anchor='mm')
# the clock ring: 9:30 of 15:00 left
r = 70; cy = 380
d.ellipse((s(cx - r), s(cy - r), s(cx + r), s(cy + r)), outline=LINE, width=s(10))
frac = 9.5 / 15
d.arc((s(cx - r), s(cy - r), s(cx + r), s(cy + r)), -90, -90 + 360 * frac, fill=OR, width=s(10))
d.text((s(cx), s(cy - 8)), '9:30', font=F('SG-Bold', s(32)), fill=INK, anchor='mm')
d.text((s(cx), s(cy + 24)), 'left', font=F('In-Reg', s(15)), fill=INK2, anchor='mm')
# the chance bar
up = 0.71; bx0, bx1, by0, by1 = 60, 1220, 618, 680
mid = bx0 + (bx1 - bx0) * up
d.rounded_rectangle((s(bx0), s(by0), s(mid - 3), s(by1)), radius=s(6), fill=UP)
d.rounded_rectangle((s(mid + 3), s(by0), s(bx1), s(by1)), radius=s(6), fill=DN)
d.text((s(bx0 + 22), s((by0 + by1) / 2)), 'UP  71 %', font=F('SG-Bold', s(28)), fill=(8, 30, 18), anchor='lm')
d.text((s(bx1 - 22), s((by0 + by1) / 2)), 'DOWN  29 %', font=F('SG-Bold', s(28)), fill=(40, 8, 8), anchor='rm')
im.resize((1280, 720), Image.LANCZOS).save('updown-market.png')
im.resize((960, 540), Image.LANCZOS).save('updown-v4.jpg', quality=88)
