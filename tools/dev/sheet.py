import sys; sys.argv = ["x", "0.35", "x"]
src = open("eval_colour.py").read().split("random.seed(2)")[0]
exec(src)
from PIL import ImageDraw
def lab2rgb(lab):
    L,a,b = lab; fy=(L+16)/116; fx=fy+a/500; fz=fy-b/200
    f=lambda t: t**3 if t**3>0.008856 else (t-16/116)/7.787
    xyz=np.array([f(fx)*0.95047,f(fy),f(fz)*1.08883])
    M=np.linalg.inv(np.array([[0.4124,0.3576,0.1805],[0.2126,0.7152,0.0722],[0.0193,0.1192,0.9505]]))
    c=M@xyz; c=np.where(c>0.0031308,1.055*np.abs(c)**(1/2.4)-0.055,12.92*c); return tuple(int(x) for x in np.clip(c*255,0,255))
random.seed(5); picks=[]
for want in ["Navy Blue","Brown","Magenta","Orange","Beige","Grey","Mustard","Purple"]:
    rs=[r for r in t if r["baseColour"]==want]; picks += [(want,r) for r in random.sample(rs,4)]
sheet=Image.new("RGB",(4*180,8*150),"white"); d=ImageDraw.Draw(sheet)
for i,(want,r) in enumerate(picks):
    im=Image.open(io.BytesIO(r["image"]["bytes"])).convert("RGB"); name,best,fg=dominant(im)
    x,y=(i%4)*180,(i//4)*150; im2=im.copy(); im2.thumbnail((90,120)); sheet.paste(im2,(x,y))
    m=Image.fromarray((fg*255).astype("uint8")).resize((60,60)); sheet.paste(m,(x+95,y))
    d.rectangle([x+95,y+65,x+155,y+95],fill=lab2rgb(best)); d.text((x+2,y+124),f"{want} -> {name}",fill="black")
sheet.save("/tmp/colour_sheet.png")
