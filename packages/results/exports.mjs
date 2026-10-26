// Two pure renderers of a Captain-validated safe export projection. No privacy policy, no validation logic, no filesystem access.
import {validateExportProjection} from './export-contract.mjs';

const NOTICE='BenchBoard — Local self-assessment; not certified; manual stopping is not enforced.\n';

/** Serialises the validated defensive copy; the caller's value is never mutated. */
export function renderReportJSON(projection){
  return JSON.stringify(validateExportProjection(projection),null,2)+'\n';
}

const flatten=(value,path,lines)=>{
  if(value!==null&&typeof value==='object'){
    const entries=Object.entries(value);
    if(entries.length===0)lines.push(`${path}: ${Array.isArray(value)?'[]':'{}'}\n`);
    else for(const [key,child] of entries)flatten(child,path?`${path}.${key}`:key,lines);
  }else lines.push(`${path}: ${JSON.stringify(value)}\n`);
};

/** Fixed flat format: notice line, then every validated leaf as dotted.path: JSON-encoded value. */
export function renderReportText(projection){
  const validated=validateExportProjection(projection);
  const lines=[NOTICE];
  flatten(validated,'',lines);
  return lines.join('');
}
