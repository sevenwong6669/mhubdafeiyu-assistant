// Electron may serialize an origin with a trailing slash. Retain the exact
// local host and port, but compare parsed origins rather than their spelling.
function petPermissionOrigin(value,port){
  try{const url=new URL(value),expected='http://127.0.0.1:'+port;return {origin:url.origin,matched:!url.username&&!url.password&&url.origin===expected};}
  catch{return {origin:'invalid',matched:false};}
}
module.exports={petPermissionOrigin};
