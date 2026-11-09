exec(open("paperdoll.py").read().split('if __name__')[0])
items = {"sweater": cut("/tmp/flatlay.jpg", [(590, 300)], 1), "jeans": cut("/tmp/flatlay.jpg", [(198, 300), (252, 300), (222, 180)]),
         "shoe": cut("/tmp/flatlay.jpg", [(985, 660)], 3), "jacket": cut("/tmp/jacket.png", [(120, 380), (430, 380)])}
for n, im in items.items():
    im.save(f"/tmp/pd/{n}.png")
    flat = Image.new("RGB", im.size, "white"); flat.paste(im, mask=im.getchannel("A")); flat.save(f"/tmp/pd/{n}_white.jpg", quality=92)
print("ok")
