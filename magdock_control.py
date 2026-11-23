from pathlib import Path
import argparse,json,time
from k20gt_probe import hid,report_layout
ROOT=Path(__file__).parent/'mhub-local-inspection'

def connect():
    entries=hid.enumerate(0x3837,0x1012)
    if len(entries)!=1: raise RuntimeError('Expected one MagDock')
    device=hid.device(); device.open_path(entries[0]['path'])
    layout=report_layout(device.get_report_descriptor())
    if layout!={'00:input':512,'00:output':512}:
        device.close(); raise RuntimeError('Unexpected MagDock report descriptor')
    return device

def send(device,command,params=b''):
    if command not in (7,39,41): raise ValueError('Command not allowed')
    payload=bytes([0xAA,command,0,0,0,len(params)])+bytes(params)
    if len(payload)>64: raise ValueError('Payload too long')
    if device.write(b'\0'+payload.ljust(64,b'\0'))!=65: raise RuntimeError('Short HID write')

def read_state(device):
    device.set_nonblocking(1)
    end=time.monotonic()+.1
    while device.read(64):
        if time.monotonic()>end: break
    device.set_nonblocking(0);send(device,7)
    end=time.monotonic()+2
    while time.monotonic()<end:
        reply=bytes(device.read(64,200))
        if len(reply)>=36 and reply[:2]==b'\xaa\x07':
            body=reply[6:]
            return {'enabled':body[0]==1,'mode':body[1],'mode_count':body[2],
                    'speed':body[3],'brightness':body[4],'sync':body[5]==1,
                    'base_rgb':list(body[6:9]),'direction':body[29],'raw':reply.hex()}
    raise TimeoutError('MagDock state response missing')

def state_params(state):
    return [int(state['enabled']),state['mode'],state['mode_count'],state['speed'],
            state['brightness'],int(state['sync']),*state['base_rgb'],state['direction']]

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--demo',action='store_true')
    parser.add_argument('--seconds',type=float,default=35);args=parser.parse_args()
    device=connect();original=read_state(device)
    print(json.dumps({'original':original}),flush=True)
    if not args.demo: device.close();return
    (ROOT/'magdock-original-state.json').write_text(json.dumps(original,indent=2),encoding='utf-8')
    report={'color':[0,120,255],'duration_s':args.seconds}
    try:
        test={**original,'enabled':True,'mode':5,'brightness':4,'sync':True}
        send(device,39,state_params(test))
        send(device,41,[0,120,255]*12)
        actual=read_state(device)
        report['active_state']=actual
        print(json.dumps({'demo':'BLUE','state':actual}),flush=True)
        # This readback only confirms the sync flag; physical color is unverified.
        if not actual['enabled'] or not actual['sync']:
            raise RuntimeError('MagDock did not enter RGB sync mode')
        until=time.monotonic()+args.seconds
        while time.monotonic()<until:
            send(device,41,[0,120,255]*12)
            time.sleep(.8)
    finally:
        send(device,39,state_params(original))
        actual=read_state(device)
        report['restored']=all(actual[k]==original[k] for k in original if k!='raw')
        (ROOT/'magdock-test-result.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
        device.close()
        print(json.dumps({'restored':report['restored']}),flush=True)
        if not report['restored']:raise RuntimeError('MagDock restore readback differs')

if __name__=='__main__':main()
