import models from './keyboard-models.json' with {type:'json'};

// Share the verified LED layout with task lighting; unsupported models never
// inherit an Ace75 count or a protocol based only on their display name.
export const BALANCE_KEYBOARDS=Object.entries(models).map(([id,spec])=>({id,...spec}));

export function balanceLayout(spec,requested='continuous'){
 const sides=spec.balanceSideRows;
 const mirrored=requested==='mirrored'&&sides?.length===2&&sides.every(row=>row.length===spec.sideCount/2);
 return {mode:mirrored?'mirrored':'continuous',segments:mirrored?sides[0].length:spec.sideCount,rows:mirrored?sides:[Array.from({length:spec.sideCount},(_,i)=>i)]};
}

export async function balanceKeyboardInventory({models}){
 const module=await loadMhubModule(),connected=new Set(module.c3().connectedDeviceIds??[]);
 const keys=[...window.ALL_CZ_STATE.deviceStateMap.keys()];
 const devices=models.filter(spec=>connected.has(spec.id)&&keys.some(d=>d.vendorId===spec.vendorId&&d.productId===spec.productId));
 if(devices.length!==1)return {available:false,reason:devices.length?'multiple-keyboards':'unsupported-keyboard',checkedAt:Date.now()};
 const spec=devices[0];return {available:true,model:spec.id,segments:spec.sideCount,checkedAt:Date.now()};
}
