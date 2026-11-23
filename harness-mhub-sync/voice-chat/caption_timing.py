"""Sentence-level audio stays continuous; screen pages follow its sample position.
Page offsets are approximate, snapped to nearby pauses where available.
"""
import numpy as np

def caption_timeline(audio,rate,pages):
    if not pages:return []
    audio=np.asarray(audio).reshape(-1);n=len(audio)
    hop=max(1,round(rate*.02))
    energy=np.array([np.sqrt(np.mean(audio[i:i+hop].astype(np.float64)**2)) for i in range(0,n,hop)])
    nonzero=energy[energy>.0001]
    threshold=max(.0001,float(np.median(nonzero))*.12 if len(nonzero) else .0001)
    pauses=[];start=None
    for i,quiet in enumerate(np.r_[energy<threshold,False]):
        if quiet and start is None:start=i
        if not quiet and start is not None:
            if i-start>=3:pauses.append(round((start+i)*hop/2))
            start=None
    weights=[max(1,sum(.25 if c.isspace() or c in '，。！？,.!?；;、' else 1 for c in text)) for text in pages]
    total=sum(weights);cumulative=0;previous=0;result=[]
    for i,text in enumerate(pages):
        target=round(n*cumulative/total)
        if i:
            candidates=[p for p in pauses if previous+rate*.2<p<n-rate*.1 and abs(p-target)<=rate*.5]
            if candidates:target=min(candidates,key=lambda p:abs(p-target))
            target=min(n-(len(pages)-i),max(previous+1,target))
        else:target=0
        result.append({'text':text,'sample':int(target)});previous=target;cumulative+=weights[i]
    return result
