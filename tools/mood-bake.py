import numpy as np, subprocess, sys
W,H=240,176; FPS=30; L=12.0; N=int(FPS*L)
yy,xx=np.mgrid[0:H,0:W].astype(np.float32)
def prof(r): return np.where(r<0.55, 1-(1-0.32)*(r/0.55), np.where(r<1, 0.32*(1-(r-0.55)/0.45), 0.0))
# пятна ходят по эллипсам: полный круг = 12 или 6 с — петля бесшовная
S=[(1.25*W,0.95,(0.36,0.52),(0.10,0.12),12,0.0),(1.05*W,0.85,(0.68,0.5),(0.12,0.14),12,0.45),(0.8*W,0.75,(0.52,0.32),(0.14,0.10),6,0.7),(0.7*W,0.6,(0.24,0.7),(0.08,0.1),6,0.2)]
rng=np.random.default_rng(5)
cmd=['ffmpeg','-y','-loglevel','error','-f','rawvideo','-pix_fmt','gray','-s',f'{W}x{H}','-r',str(FPS),'-i','-','-c:v','libx264','-preset','slow','-crf','20','-pix_fmt','yuv420p','-tag:v','avc1','-movflags','+faststart','-an',sys.argv[1]]
p=subprocess.Popen(cmd,stdin=subprocess.PIPE)
for f in range(N):
    t=f/FPS
    img=np.zeros((H,W),np.float32)
    for (d,op,(cx,cy),(ax,ay),per,ph) in S:
        a=2*np.pi*(t/per+ph)
        x=(cx+ax*np.cos(a))*W; y=(cy+ay*np.sin(a))*H
        sc=1+0.12*np.sin(a*2)
        r=np.hypot(xx-x,yy-y)/(d/2*sc)
        al=op*prof(r)
        img=img*(1-al)+1.0*al
    img=img*255+rng.uniform(-0.6,0.6,img.shape)
    p.stdin.write(np.clip(img,0,255).astype(np.uint8).tobytes())
p.stdin.close(); p.wait()
