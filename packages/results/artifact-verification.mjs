// Captain-owned cooperative file/root boundary. No hostile-writer OS sandbox guarantee.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDisjointRoots, resolveWithinRoot } from '../core/paths.mjs';
import { sha256 } from '../core/identity.mjs';
import { canonicalJson } from '../core/manifest.mjs';
import { assertDirectoryChain } from '../evaluation/staging.mjs';
export class PublicationError extends Error {
  constructor(code,message) {super(message);this.name='PublicationError';this.code=code;}
}
export const publicationRefusal=(code,message)=>{throw new PublicationError(code,message);};
const OWNER_ROOT=fileURLToPath(new URL('../..',import.meta.url));
export function assertReportRoots(roots) {
  const entries=[OWNER_ROOT,...roots];
  for (const root of roots) {
    if (typeof root!=='string' || !path.isAbsolute(root) || path.resolve(root)!==root || path.dirname(root)===root || /[\x00-\x1f\x7f]/.test(root)) publicationRefusal('PUBLICATION_PATH','Explicit canonical absolute ordinary root required');
    assertDirectoryChain(root);
  }
  assertDisjointRoots(entries);
  assertDisjointRoots(entries.map(root=>fs.realpathSync.native(root)));
}
export function verifyReportArtifacts(root,records,{maxFileBytes=134217728,maxTotalBytes=536870912}={}) {
  if (!Array.isArray(records) || records.length>512) publicationRefusal('PUBLICATION_ARTIFACT','Bounded artifact inventory required');
  const chain=assertDirectoryChain(root), seen=new Set();let total=0;
  for (const item of records) {
    if (!item || typeof item.path!=='string' || seen.has(item.path) || !Number.isSafeInteger(item.bytes) || item.bytes<0 || item.bytes>maxFileBytes || !/^[a-f0-9]{64}$/.test(item.sha256??'') || (total+=item.bytes)>maxTotalBytes) publicationRefusal('PUBLICATION_ARTIFACT','Artifact reference bounds or identity refused');
    seen.add(item.path);
    const absolute=resolveWithinRoot({root,relativePath:item.path});
    const beforeChain=assertDirectoryChain(path.dirname(absolute));
    const before=fs.lstatSync(absolute);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink!==1 || before.size!==item.bytes) publicationRefusal('PUBLICATION_ARTIFACT','Artifact must be an unlinked ordinary file of the recorded size');
    let fd;
    try {
      fd=fs.openSync(absolute,fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW??0));
      const opened=fs.fstatSync(fd);
      const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs&&a.nlink===b.nlink;
      if (!same(before,opened) || !opened.isFile()) publicationRefusal('PUBLICATION_ARTIFACT','Artifact changed before descriptor read');
      // Bound the read even if an uncooperative writer grows a file after lstat.
      const buffer=Buffer.alloc(item.bytes+1);let length=0;
      while(length<buffer.length) {const count=fs.readSync(fd,buffer,length,buffer.length-length,null);if(count===0)break;length+=count;}
      const content=buffer.subarray(0,length),after=fs.fstatSync(fd),named=fs.lstatSync(absolute);
      if (!same(opened,after) || !same(after,named) || content.length!==item.bytes || sha256(content)!==item.sha256) publicationRefusal('PUBLICATION_ARTIFACT','Artifact bytes, digest or identity changed');
    } finally {if(fd!==undefined)fs.closeSync(fd);}
    if(canonicalJson(beforeChain)!==canonicalJson(assertDirectoryChain(path.dirname(absolute)))) publicationRefusal('PUBLICATION_ARTIFACT','Artifact ancestor ownership changed');
  }
  if(canonicalJson(chain)!==canonicalJson(assertDirectoryChain(root))) publicationRefusal('PUBLICATION_ARTIFACT','Artifact root ownership changed');
}
