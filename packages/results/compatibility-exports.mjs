// Two pure renderers of a Captain-validated safe compatibility export. No privacy policy, no validation logic, no filesystem access.
import {validateCompatibilityExport} from './compatibility-export-contract.mjs';

const NOTICE='BenchBoard — Descriptive compatibility; no current authority or formal comparison.\n';

/** Serialises the validated defensive copy; the caller's value is never mutated. */
export function renderCompatibilityJSON(projection){
  return JSON.stringify(validateCompatibilityExport(projection),null,2)+'\n';
}

const flatten=(value,path,lines)=>{
  if(value!==null&&typeof value==='object'){
    const entries=Object.entries(value);
    if(entries.length===0)lines.push(`${path}: ${Array.isArray(value)?'[]':'{}'}\n`);
    else for(const [key,child] of entries)flatten(child,path?`${path}.${key}`:key,lines);
  }else lines.push(`${path}: ${JSON.stringify(value)}\n`);
};

/** Fixed flat format: notice line, then every validated leaf as dotted.path: JSON-encoded value. */
export function renderCompatibilityText(projection){
  const validated=validateCompatibilityExport(projection);
  const lines=[NOTICE];
  flatten(validated,'',lines);
  return lines.join('');
}
