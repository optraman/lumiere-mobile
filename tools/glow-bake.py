import numpy as np, subprocess, sys
W,H=270,588           # кадр (≈ 9:19.6 — пропорции iPhone 16/17 Pro)
FPS=30; L=42.0        # петля 42 с
N=int(FPS*L)
BG=np.array([8,8,10],np.float32)/255
def hx(c): return np.array([int(c[i:i+2],16) for i in (1,3,5)],np.float32)/255
SPEED=0.7; DIM=0.85
# (size×W, color, alt, half-period s (кратно петле), opacity, phase, path)
B=[
 (2.2,'#CCCC99','#E6D5B0',10.5,0.12,0.0,[(.18,.1),(.62,.24),(.3,.06)]),
 (1.75,'#E0C89A',None,14.0,0.087,0.35,[(.85,.3),(.45,.5),(.78,.16)]),
 (2.55,'#CBC6BA','#C8BE8C',21.0,0.067,0.7,[(.1,.72),(.55,.54),(.15,.88)]),
 (1.45,'#CFCFA8',None,10.5,0.093,0.15,[(.7,.12),(.26,.36),(.88,.42)]),
 (1.95,'#D8C89C','#D9C38A',21.0,0.06,0.55,[(.06,.42),(.36,.8),(.02,.6)]),
 (1.2,'#CCCC99',None,14.0,0.073,0.85,[(.56,.88),(.2,.64),(.72,.96)]),
 (1.6,'#D9C38A','#BFB58A',21.0,0.07,0.25,[(.92,.66),(.6,.78),(.82,.5)]),
 (1.35,'#E6D5B0',None,21.0,0.08,0.6,[(.4,.32),(.12,.22),(.5,.46)]),
]
# 14 и 10.5 и 21 — полупериоды; полный цикл 2h должен делить 42: 21 ✓, 42 ✓ (14→28 ✗) → 14 заменяем на 10.5/21
B=[(s,c,a,(10.5 if h==14.0 else h),o,p,pt) for (s,c,a,h,o,p,pt) in B]
yy,xx=np.mgrid[0:H,0:W].astype(np.float32)
def ease(t): # Easing.inOut(ease) ≈ smoothstep-ish (cubic bezier .42,0,.58,1)
    return t*t*(3-2*t)
def tri(t,h,phase):
    # пинг-понг 0→1→0, полцикла h секунд, старт с фазы
    u=(t/h+phase)%2.0
    v=u if u<=1 else 2-u
    return ease(v)
def lerp3(v,pts):
    if v<=0.5:
        k=v/0.5; a,b=pts[0],pts[1]
    else:
        k=(v-0.5)/0.5; a,b=pts[1],pts[2]
    return (a[0]+(b[0]-a[0])*k, a[1]+(b[1]-a[1])*k)
def prof(r):
    return np.where(r<0.55, 1-(1-0.32)*(r/0.55), np.where(r<1, 0.32*(1-(r-0.55)/0.45), 0.0))
rng=np.random.default_rng(3)
cmd=['ffmpeg','-y','-loglevel','error','-f','rawvideo','-pix_fmt','rgb24','-s',f'{W}x{H}','-r',str(FPS),'-i','-',
     '-c:v','libx264','-preset','slow','-crf',sys.argv[2] if len(sys.argv)>2 else '20','-pix_fmt','yuv420p','-tag:v','avc1','-movflags','+faststart','-an',sys.argv[1]]
p=subprocess.Popen(cmd,stdin=subprocess.PIPE)
poster=None
for f in range(N):
    t=f/FPS
    img=np.broadcast_to(BG,(H,W,3)).copy()
    for (sz,c,alt,h,op,ph,pts) in B:
        v=tri(t,h,ph)
        cx,cy=lerp3(v,pts)
        scale=1+0.22*(1-abs(2*v-1))   # 1 → 1.22 → 1
        R=sz*W/2*scale
        r=np.hypot(xx-cx*W,yy-cy*W*(H/W)/ (H/W) if False else yy-cy*H)/R
        a=(op*DIM*prof(r))[...,None]
        col=hx(c)
        if alt:
            s=tri(t,21.0,0.5)          # перелив оттенка — полный цикл 42 с
            col=col*(1-s)+hx(alt)*s
        img=img*(1-a)+col*a
    img=img*255+rng.uniform(-0.6,0.6,img.shape)
    fr=np.clip(img,0,255).astype(np.uint8)
    if f==0: poster=fr
    p.stdin.write(fr.tobytes())
p.stdin.close(); p.wait()
from PIL import Image
Image.fromarray(poster).save(sys.argv[1].replace('.mp4','_poster.png'))
