# Generates Life HQ icons (red bell on dark background). Run: python3 make-icons.py <outdir>
import sys
from PIL import Image, ImageDraw
out = sys.argv[1] if len(sys.argv) > 1 else '.'
def icon(size):
    S = 4 * size  # supersample
    im = Image.new('RGBA', (S, S), (17, 19, 26, 255))
    d = ImageDraw.Draw(im)
    u = S / 100.0
    # glow circle (kept inside maskable safe zone)
    d.ellipse([18*u, 18*u, 82*u, 82*u], fill=(60, 18, 22, 255))
    red = (239, 59, 59, 255)
    # bell dome + body
    d.ellipse([34*u, 26*u, 66*u, 56*u], fill=red)
    d.polygon([(34*u, 42*u), (66*u, 42*u), (72*u, 64*u), (28*u, 64*u)], fill=red)
    d.rounded_rectangle([25*u, 61*u, 75*u, 67*u], radius=3*u, fill=red)
    # top knob and clapper
    d.ellipse([46.5*u, 21*u, 53.5*u, 28*u], fill=red)
    d.ellipse([44*u, 66*u, 56*u, 76*u], fill=red)
    # alert lines
    w = int(3*u)
    d.line([(22*u, 34*u), (16*u, 30*u)], fill=red, width=w)
    d.line([(78*u, 34*u), (84*u, 30*u)], fill=red, width=w)
    d.line([(20*u, 46*u), (13*u, 46*u)], fill=red, width=w)
    d.line([(80*u, 46*u), (87*u, 46*u)], fill=red, width=w)
    im.resize((size, size), Image.LANCZOS).save(f'{out}/icon-{size}.png')
for s in (192, 512):
    icon(s)
print('ok')
