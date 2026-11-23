"""Clear double-frequency telephone cues with click-free attack and release."""
import numpy as np
def telephone_wave(kind,volume,rate=24000):
    if kind not in ('dial','ring'):raise ValueError('unknown telephone cue')
    volume=max(0,min(60,float(volume)));gain=min(.66,volume*.011)
    length=4.0 if kind=='dial' else 3.6
    t=np.arange(round(rate*length),dtype=np.float64)/rate
    wave=np.zeros(len(t),dtype=np.float64)
    segments=[(0,.72),(.98,1.70)] if kind=='dial' else [(0,.64),(.86,1.50)]
    for start,end in segments:
        local=t-start;mask=(local>=0)&(t<end);u=local[mask]
        envelope=np.minimum(1,u/.015)*np.minimum(1,(end-start-u)/.025)
        if kind=='dial':sound=.5*np.sin(2*np.pi*440*u)+.5*np.sin(2*np.pi*480*u)
        else:sound=(.6*np.sin(2*np.pi*740*u)+.4*np.sin(2*np.pi*988*u))*(.75+.25*np.cos(2*np.pi*12*u))
        wave[mask]=sound*envelope*gain
    return wave.astype('float32')
