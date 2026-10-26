// Two pure renderers of a Captain-validated descriptive comparison. No privacy policy, no validation logic of our own, no filesystem access.
import {validateComparison} from './comparison.mjs';

const NOTICE='BenchBoard — Descriptive comparison; manual unenforced; not formally controlled.\n';

const flatten=(value,path,lines)=>{
  if(value!==null&&typeof value==='object'){
    const entries=Object.entries(value);
    if(entries.length===0)lines.push(`${path}: ${Array.isArray(value)?'[]':'{}'}\n`);
    else for(const [key,child] of entries)flatten(child,path?`${path}.${key}`:key,lines);
  }else lines.push(`${path}: ${JSON.stringify(value)}\n`);
};

/** Serialises the validated defensive copy as pretty JSON (two-space indent, trailing newline); the caller's value is never mutated. */
export function renderComparisonJSON(projection){
  return JSON.stringify(validateComparison(projection),null,2)+'\n';
}

/** Fixed flat format: notice line, then every validated leaf as dotted.path: JSON-encoded value. */
export function renderComparisonText(projection){
  const validated=validateComparison(projection);
  const lines=[NOTICE];
  flatten(validated,'',lines);
  return lines.join('');
}
