# #1197: the Up or Down card's chart, drawn the way the marketing chart.py draws candles, in the Arena's own look (no trading-site chrome):
# 10-second candles across one 15-minute round, the price to beat, and the round's chance of up.
from PIL import Image, ImageDraw, ImageFont
FD = '/tmp/claude-1000/-home-daniel-marketing/e57274cb-2da0-4b2d-bce8-60829622d86b/scratchpad/fonts/'
F = lambda n, s: ImageFont.truetype(FD + n + '.ttf', s)
S = 2  # drawn at 2x, saved at 1280x720
W, H = 1280 * S, 720 * S
BG = (14, 14, 16); PANEL = (20, 20, 23); LINE = (38, 38, 42); GRID = (28, 28, 32)
INK = (236, 236, 236); INK2 = (163, 163, 168); INK3 = (110, 110, 116)
UP = (63, 191, 127); DN = (229, 83, 75); OR = (247, 147, 26)
# the candles (open, close) and wicks (up, down), in dollars over 78,000: a dip, a squeeze, a spike, a dump, the climb back
P = [(141, 141.5), (141.5, 141), (141, 142), (142, 141.5), (141.5, 142.5), (142.5, 142), (142, 136), (136, 128), (128, 127), (127, 120),
     (120, 119.5), (119.5, 120), (120, 120.5), (120.5, 100), (100, 108), (108, 108.5), (108.5, 143), (143, 147), (147, 146.5), (146.5, 146),
     (146, 146.5), (146.5, 145.5), (145.5, 146), (146, 108), (108, 108.5), (108.5, 104), (104, 108), (108, 106.5), (106.5, 122), (122, 133),
     (133, 133.5), (133.5, 133), (133, 133.5)]
WK = [(.5, .5), (.5, .5), (1, .5), (.5, .5), (.5, .5), (.5, .5), (.5, 1), (.5, 1.5), (1.5, .5), (.5, 2), (1, .5), (.5, .5), (.5, .5), (.5, 1),
      (1, 1.5), (.5, .5), (1, .5), (1.5, .5), (1, .5), (.5, .5), (.5, .5), (.5, .5), (.5, .5), (.5, 1), (.5, .5), (.5, 1), (.5, .5), (.5, .5),
      (1, 1), (1, .5), (1, .5), (.5, .5), (1, .5)]
VOL = [2, 2, 3, 2, 2, 2, 9, 12, 3, 8, 2, 2, 2, 24, 7, 2, 30, 9, 3, 2, 2, 2, 2, 28, 3, 7, 4, 3, 11, 12, 3, 2, 2]
BEAT = 120.0
L, T, R, B = 40, 150, 1150, 640           # plot area (1x units)
VB = 590                                  # volume rises from B to VB
PMIN, PMAX = 96, 152
N = len(P); step = (R - L - 20) / N
y = lambda p: T + (PMAX - p) / (PMAX - PMIN) * (VB - 14 - T)
x = lambda i: L + 10 + step * (i + .5)
s = lambda v: int(round(v * S))

im = Image.new('RGB', (W, H), BG); d = ImageDraw.Draw(im)
# header: the market, the price now, the price to beat, the chance of up
d.text((s(40), s(46)), 'Bitcoin Up or Down', font=F('SG-Bold', s(30)), fill=INK, anchor='lm')
d.text((s(40), s(82)), 'BTC / USD · 10-second candles · round 20:00–20:15 UTC', font=F('In-Reg', s(17)), fill=INK2, anchor='lm')
o, c = P[-1]
d.text((s(1240), s(42)), f'$78,{c:06.2f}', font=F('SG-Bold', s(30)), fill=INK, anchor='rm')
d.text((s(1240), s(76)), f'+${c - BEAT:.2f} over the price to beat', font=F('In-Semi', s(16)), fill=UP, anchor='rm')
# chance pills
def pill(x0, label, val, col):
    d.rounded_rectangle((s(x0), s(102), s(x0 + 150), s(134)), radius=s(6), outline=col, width=s(1.5))
    d.text((s(x0 + 14), s(118)), label, font=F('In-Semi', s(16)), fill=col, anchor='lm')
    d.text((s(x0 + 136), s(118)), val, font=F('In-Semi', s(16)), fill=INK, anchor='rm')
pill(930, '▲ Up', '71 %', UP); pill(1090, '▼ Down', '29 %', DN)
# grid
for p in range(100, 151, 10):
    d.line((s(L), s(y(p)), s(R), s(y(p))), fill=GRID, width=S)
for i in range(0, N + 1, 6):
    xx = L + 10 + step * i; d.line((s(xx), s(T), s(xx), s(B)), fill=GRID, width=S)
d.line((s(L), s(B), s(R), s(B)), fill=LINE, width=S)
# volume
vm = max(VOL)
for i, v in enumerate(VOL):
    o_, c_ = P[i]; col = UP if c_ >= o_ else DN
    h = v / vm * (B - VB); dim = tuple(int(BG[k] + (col[k] - BG[k]) * .38) for k in range(3))
    d.rectangle((s(x(i) - step * .34), s(B - h), s(x(i) + step * .34), s(B)), fill=dim)
# the price to beat: a dashed orange line with its label
xx = L
while xx < R:
    d.line((s(xx), s(y(BEAT)), s(min(xx + 8, R)), s(y(BEAT))), fill=OR, width=s(1.5)); xx += 14
# candles
for i, ((o_, c_), (wu, wd)) in enumerate(zip(P, WK)):
    col = UP if c_ >= o_ else DN
    hi = max(o_, c_) + wu; lo = min(o_, c_) - wd
    d.line((s(x(i)), s(y(hi)), s(x(i)), s(y(lo))), fill=col, width=S)
    y0, y1 = sorted((y(o_), y(c_)))
    d.rounded_rectangle((s(x(i) - step * .34), s(y0), s(x(i) + step * .34), s(max(y1, y0 + 2))), radius=s(1.5), fill=col)
# the price scale and the two tags
for p in range(100, 151, 10):
    d.text((s(R + 14), s(y(p))), f'78,{p:03d}', font=F('In-Reg', s(14)), fill=INK3, anchor='lm')
def tag(p, text, col, ink):
    d.rounded_rectangle((s(R + 6), s(y(p) - 13), s(1270), s(y(p) + 13)), radius=s(4), fill=col)
    d.text((s(R + 14), s(y(p))), text, font=F('In-Semi', s(14)), fill=ink, anchor='lm')
tag(BEAT, f'78,{BEAT:.0f} beat', OR, (17, 17, 17))
tag(c, f'78,{c:06.2f}', UP, (10, 20, 14))
d.line((s(x(N - 1)), s(y(c)), s(R), s(y(c))), fill=UP, width=S)
# time scale
for i in range(0, N + 1, 6):
    xx = L + 10 + step * i; t = 10 * i
    d.text((s(xx), s(B + 22)), f'20:{t // 60:02d}:{t % 60:02d}', font=F('In-Reg', s(14)), fill=INK3, anchor='mm')
d.text((s(R), s(B + 52)), 'closes 20:15 UTC · 9:30 left', font=F('In-Reg', s(14)), fill=INK2, anchor='rm')
im.resize((1280, 720), Image.LANCZOS).save('updown-chart.png')
im.resize((960, 540), Image.LANCZOS).save('updown-v3.jpg', quality=88)
