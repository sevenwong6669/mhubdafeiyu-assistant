// Speech boundaries must never read Harness transport metadata aloud. Ordinary
// answers are retained; protocol-only replies are failures, not canned answers.
export function inspectSpeechOutput(value){
 const raw=String(value??'');
 const hasMetadata=/^\s*(?:Time sampled while preparing turn \d+, step \d+:|Browser time zone for this request:|Elapsed since the preceding model-visible message:)/m.test(raw);
 const hasProtocol=/<\s*\/?\s*[｜|]{2}\s*DSML\s*[｜|]{2}/i.test(raw);
 let text=raw
  .replace(/<\s*\/?\s*[｜|]{2}\s*DSML\s*[｜|]{2}[^>]*>/gi,'')
  .replace(/<at:\d+>/g,'')
  .replace(/^\s*(?:Time sampled while preparing turn \d+, step \d+:|Browser time zone for this request:|Elapsed since the preceding model-visible message:)[^\r\n]*(?:\r?\n|$)/gm,'');
 if(hasMetadata)text=text.replace(/^\s*m\d{4,}\s*$/gm,'');
 text=text.replace(/\n{3,}/g,'\n\n').trim();
 return {text,valid:!!text,reason:text?null:hasMetadata?'host-metadata':hasProtocol?'model-protocol':'empty'};
}
