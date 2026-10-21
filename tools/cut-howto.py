#!/usr/bin/env python3
# THE OWNER'S HOW-TO, CUT AT ITS TRUE EDGES (2026-09-14) for the loading screen.
#
# The four tiles that came with it (Assets/Art/Resources/lobby-howto-1..4.png,
# 724x543 each) were cut at the image's half height, y 543. The rows of the
# picture are really separated at y 625-649 (fully transparent there), so tile 1
# lost its bottom - the players and the truck - to tile 3, and tile 2 its bottom
# to tile 4. In 1-2 over 3-4 the strips line up and it cannot be seen; in one
# row it shows (measured on the live page, 1280x800).
#
# So each panel is taken from the owner's WHOLE (lobby-howto.png, 1448x1086) by the
# box of its own opaque pixels, measured in each quadrant split at the gaps. His
# files are not changed; these go beside the page. The Unity lobby draws the same
# boxes from the whole texture (DailyLobby.PanelBoxes).
#
#   python3 packages/nextblock/unity/tools/cut-howto.py
from pathlib import Path
from PIL import Image

HERE = Path(__file__).resolve().parent.parent   # the repository (this tool is the Arena's: the how-to pictures are its page's, kanban #569)
WHOLE = HERE / 'packages/nextblock/unity/Assets/Art/Resources/lobby-howto.png'
OUT = HERE / 'src/arena-ui'   # the Arena page's source
# x0, y0, x1, y1 in the whole - the measured boxes (DailyLobby.PanelBoxes)
BOXES = [(32, 80, 699, 625), (726, 82, 1440, 625), (23, 650, 711, 1019), (752, 653, 1429, 1020)]

im = Image.open(WHOLE).convert('RGBA')
assert im.size == (1448, 1086), f'the whole is {im.size}, not 1448x1086'
for n, box in enumerate(BOXES, 1):
    panel = im.crop(box)
    panel.save(OUT / f'howto-{n}.png', optimize=True)
    print(f'howto-{n}.png: {panel.size[0]}x{panel.size[1]} from {box}')
