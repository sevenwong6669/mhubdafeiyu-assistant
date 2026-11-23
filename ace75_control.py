"""Restricted Ace75 8K light inspection, based on the official CZ SDK."""
import json,time
from k20gt_probe import hid,report_layout
from magdock_control import ROOT

def connect():
    matches=[e for e in hid.enumerate(0x3837,0x303c)
             if e['interface_number']==1 and e['usage_page']==1 and e['usage']==0]
    if len(matches)!=1:raise RuntimeError('Expected one Ace75 vendor interface')
    d=hid.device();d.open_path(matches[0]['path'])
    if report_layout(d.get_report_descriptor())!={'00:input':512,'00:output':512}:
        d.close();raise RuntimeError('Unexpected Ace75 descriptor')
    return d

def command(d,cmd,offset=0,size=56,data=None):
    if data is not None:
        color_write=cmd==6 and 0<=offset//64<4 and (
            (offset%64==14 and len(data)==3) or (offset%64==8 and len(data)==1))
        live_write=cmd==221 and offset%3==0 and len(data)%3==0 and 0<=offset<285 and offset+len(data)<=285
        if not(color_write or live_write):
            raise ValueError('Only documented main-light RGB or effect writes allowed')
        size=len(data)
    elif cmd not in (3,4,5,222):raise ValueError('Only documented reads allowed')
    if not 1<=size<=56:raise ValueError('Invalid size')
    h=bytes([size,offset&255,offset>>8,0])+bytes(data or b'')
    packet=bytes([0x55,cmd,0,sum(h)&255])+h
    if d.write(b'\0'+packet.ljust(64,b'\0'))!=65:raise RuntimeError('Short write')
    end=time.monotonic()+2
    while time.monotonic()<end:
        r=bytes(d.read(64,200))
        if len(r)>=8 and r[:2]==bytes([0xaa,cmd]) and r[5:7]==h[1:3] and r[4]<=size:
            return r[8:8+r[4]]
    raise TimeoutError(f'Ace75 read {cmd} did not reply')

def read_block(d,cmd,offset,size):
    return b''.join(command(d,cmd,offset+i,min(56,size-i)) for i in range(0,size,56))

def main():
    d=connect()
    try:
        info=read_block(d,3,0,56);base=read_block(d,4,0,56)
        result={'info':list(info),'base':list(base)}
        if sorted(base[2:6])!=list(range(4)) or not 0<=base[0]<base[1]<=4:
            raise RuntimeError('Unrecognized active profile layout')
        profile=base[2+base[0]]
        config=read_block(d,5,profile*64,64)
        if len(config)!=64:raise RuntimeError('Short function config')
        result.update(profile=profile,config=list(config))
        # Preserve raw base information before interpreting the active profile.
        (ROOT/'ace75-read.json').write_text(json.dumps(result,indent=2))
        print(json.dumps(result),flush=True)
    finally:d.close()

if __name__=='__main__':main()
