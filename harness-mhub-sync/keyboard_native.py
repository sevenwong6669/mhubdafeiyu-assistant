"""Known CZ keyboard RAM lighting only. No key mapping or performance writes."""
from pathlib import Path
import json,time,sys
ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT.parent))
from k20gt_probe import hid,report_layout
from ace75_control import read_block
MODELS=json.loads((ROOT/'keyboard-models.json').read_text(encoding='utf-8'))
def connected():
    return [name for name,spec in MODELS.items() if any(e['interface_number']==1 and e['usage_page']==1 and e['usage']==0 for e in hid.enumerate(spec['vendorId'],spec['productId']))]
def connect(name):
    spec=MODELS[name]
    matches=[e for e in hid.enumerate(spec['vendorId'],spec['productId']) if e['interface_number']==1 and e['usage_page']==1 and e['usage']==0]
    if len(matches)!=1:raise RuntimeError('Expected one '+name+' lighting interface')
    d=hid.device();d.open_path(matches[0]['path'])
    if report_layout(d.get_report_descriptor())!={'00:input':512,'00:output':512}:
        d.close();raise RuntimeError('Unknown keyboard HID layout')
    return d
def frame(d,colors,name,main_only=False):
    spec=MODELS[name]
    if len(colors)!=spec['frameBytes'] or any(type(n)!=int or not 0<=n<=255 for n in colors):raise ValueError('Invalid keyboard RGB frame')
    ranges=[(221,0,spec['mainKeys']*3)]
    # GT75 uses the SDK's dedicated 223 side-light RAM command. Ace's
    # independent strip keeps its established native palette channel.
    if name=='GT 75' and not main_only:ranges.append((223,spec['sideStart']*3,(spec['sideStart']+spec['sideCount'])*3))
    for cmd,begin,end in ranges:
        for offset in range(begin,end,54):
            part=colors[offset:min(offset+54,end)]
            header=bytes([len(part),offset&255,offset>>8,0])+bytes(part)
            packet=bytes([0x55,cmd,0,sum(header)&255])+header
            if d.write(b'\0'+packet.ljust(64,b'\0'))!=65:raise RuntimeError('Short keyboard light write')
            time.sleep(.02)
def balance_side_frame(d,colors,name):
    # A separate fixed balance plane; GIF colors never enter this command.
    spec=MODELS[name]
    if name!='GT 75' or len(colors)!=spec['sideCount']*3 or any(type(v)!=int or not 0<=v<=255 for v in colors):raise ValueError('Invalid balance-only side frame')
    begin=spec['sideStart']*3
    for local in range(0,len(colors),54):
        part=colors[local:local+54];offset=begin+local
        header=bytes([len(part),offset&255,offset>>8,0])+bytes(part)
        packet=bytes([0x55,223,0,sum(header)&255])+header
        if d.write(b'\0'+packet.ljust(64,b'\0'))!=65:raise RuntimeError('Short balance light write')
        time.sleep(.02)

def light_bytes(d,profile,offset,data):
    if type(profile)!=int or not 0<=profile<4 or offset not in (8,24) or len(data) not in (1,2):raise ValueError('Only effect and brightness bytes allowed')
    offset=profile*64+offset;data=bytes(data)
    header=bytes([len(data),offset&255,offset>>8,0])+data
    packet=bytes([0x55,6,0,sum(header)&255])+header
    if d.write(b'\0'+packet.ljust(64,b'\0'))!=65:raise RuntimeError('Short light parameter write')
    end=time.monotonic()+2
    while time.monotonic()<end:
        reply=bytes(d.read(64,200))
        if len(reply)>=8 and reply[:2]==b'\xaa\x06' and reply[5:7]==header[1:3]:return
    raise TimeoutError('Light parameter write not acknowledged')
def restore_effect(d,profile,config,name,main_only=False):
    from ace75_control import command
    if name=='GT 75':
        light_bytes(d,profile,8,list(config[8:10]))
        if not main_only:light_bytes(d,profile,24,list(config[24:26]))
    else:command(d,6,profile*64+8,data=[config[8]])
