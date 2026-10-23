# AA contrast check for the design tokens in src/styles.css. Run: python3 scripts/check-contrast.py

import math,re
def oklch_to_srgb(L,C,h):
    a=C*math.cos(math.radians(h)); b=C*math.sin(math.radians(h))
    l_=L+0.3963377774*a+0.2158037573*b
    m_=L-0.1055613458*a-0.0638541728*b
    s_=L-0.0894841775*a-1.2914855480*b
    l,m,s=l_**3,m_**3,s_**3
    r=4.0767416621*l-3.3077115913*m+0.2309699292*s
    g=-1.2684380046*l+2.6097574011*m-0.3413193965*s
    bb=-0.0041960863*l-0.7034186147*m+1.7076147010*s
    def f(x):
        x=max(0,min(1,x))
        return 12.92*x if x<=0.0031308 else 1.055*x**(1/2.4)-0.055
    return [f(r),f(g),f(bb)]
def parse(v):
    m=re.match(r'oklch\(([\d.]+) ([\d.]+) ([\d.]+)(?: / ([\d.]+)(%?))?\)',v)
    L,C,h=map(float,m.groups()[:3]); al=1.0
    if m.group(4): al=float(m.group(4))/(100 if m.group(5) else 1)
    return oklch_to_srgb(L,C,h),al
def lin(c): return c/12.92 if c<=0.04045 else ((c+0.055)/1.055)**2.4
def lum(rgb): r,g,b=[lin(x) for x in rgb]; return 0.2126*r+0.7152*g+0.0722*b
def blend(fg,al,bg): return [fg[i]*al+bg[i]*(1-al) for i in range(3)]
css=open('src/styles.css').read()
def block(sel):
    i=css.index(sel+' {'); j=css.index('\n}\n',i); body=css[i:j]
    return dict(re.findall(r'--([\w-]+): (oklch\([^;]+\));',body))
for name,sel in [('light',':root'),('dark','.dark')]:
    t=block(sel)
    def c(k): return parse(t[k])
    def ratio(fgk,bgk,over=None):
        bg,ba=c(bgk)
        if over: ob,_=c(over); bg=blend(bg,ba,ob)
        fg,fa=c(fgk)
        fg=blend(fg,fa,bg)
        l1,l2=lum(fg),lum(bg)
        if l1<l2:l1,l2=l2,l1
        return (l1+.05)/(l2+.05)
    pairs=[('foreground','background',None),('foreground','card',None),('muted-foreground','background',None),('muted-foreground','card',None),('muted-foreground','muted',None),('primary-foreground','primary',None),('primary','background',None),('primary','card',None),('destructive-foreground','destructive',None),('success-ink','success-soft','card'),('warning-ink','warning-soft','card'),('info-ink','info-soft','card'),('destructive-ink','destructive-soft','card'),('neutral-ink','neutral-soft','card'),('money-in','card',None),('money-out','card',None),('sidebar-foreground','sidebar',None),('sidebar-accent-foreground','sidebar-accent',None),('sidebar-primary','sidebar',None),('accent-foreground','accent',None),('secondary-foreground','secondary',None),('warning-foreground','warning',None)]
    print(name)
    for f,b,o in pairs:
        r=ratio(f,b,o); print(f"  {f:26s} on {b:18s} {r:5.2f} {'OK' if r>=4.5 else ('large-only' if r>=3 else 'FAIL')}")
