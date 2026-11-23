"""Render the K20 GT clock into one 256×32 monochrome frame."""
import base64
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent / 'python-deps'))
from PIL import Image, ImageDraw, ImageFont

data = json.load(sys.stdin)
image = Image.new('L', (256, 32))
draw = ImageDraw.Draw(image)
small = ImageFont.truetype(r'C:\Windows\Fonts\msyhbd.ttc', 12)
large = ImageFont.truetype(r'C:\Windows\Fonts\consolab.ttf', 29)
draw.text((128, 16), data['time'], anchor='mm', font=large, fill=255)

def line(text, left, top, width, right=False):
    text = str(text)
    if draw.textlength(text, font=small) > width:
        while text and draw.textlength(text + '…', font=small) > width:
            text = text[:-1]
        text += '…'
    draw.text((left + width if right else left, top), text, anchor='rt' if right else 'lt', font=small, fill=255)

line(data['date'], 3, 2, 76)
line(data['weekday'], 3, 18, 76)
line(data.get('weather', ''), 177, 2, 76, True)
line(data.get('location', ''), 177, 18, 76, True)
packed = bytes(sum((image.getpixel((x, page * 8 + bit)) >= 100) << bit for bit in range(8))
               for page in range(4) for x in range(256))
print(base64.b64encode(packed).decode('ascii'))
