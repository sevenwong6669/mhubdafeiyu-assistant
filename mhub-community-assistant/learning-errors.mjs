export function learningError(error){
 const message=String(error?.message??error??'整理未完成').slice(0,500);
 const code=error?.name==='AbortError'||error?.name==='TimeoutError'?'cancelled':error?.code==='EEXIST'?'write_locked':/容量|过大/.test(message)?'capacity':/格式损坏|JSON|Unexpected token/.test(message)?'corrupt_data':/格式已变化|响应过大|社区拒绝/.test(message)?'interface_changed':/noDeviceScope|设备范围/.test(message)?'device_unavailable':/fetch|network|HTTP|超时|读取失败|ENOTFOUND|ECONN/i.test(message)?'network':'internal';
 return {code,message};
}
