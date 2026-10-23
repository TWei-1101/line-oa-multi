/** Dedicated deployment entrypoint: credentials are files, never environment/argv. */
import { constants, openSync, fstatSync, readFileSync, closeSync, lstatSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { createFamilyBridgeServer, type FamilyHttpOptions } from './family-bridge-server.js';
export type FamilyFileOptions={bridgeTokenFile:string;upstreamTokenFile:string;groupsFile:string;ledgerPath:string;upstream:string};
function fail():never {throw new Error('FAMILY_FILE_CONFIG');}
function parents(path:string):void {
  if(!isAbsolute(path)||resolve(path)!==path)fail();
  for(let d=dirname(path);;d=dirname(d)){
    const st=lstatSync(d);
    const stickyRootAncestor=d!==dirname(path)&&st.uid===0&&(st.mode&0o1000)!==0;
    if(!st.isDirectory()||st.isSymbolicLink()||((st.mode&0o022)!==0&&!stickyRootAncestor))fail();
    if(d==='/')break;
  }
}
function protectedFile(path:string):string {
  parents(path);
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const st=fstatSync(fd);
    if(!st.isFile()||st.nlink!==1||(st.mode&0o137)!==0||st.size>8192||st.size===0||![0,process.getuid?.()].includes(st.uid))fail();
    return readFileSync(fd,'utf8');
  }finally{closeSync(fd);}
}
export function readFamilyBridgeFiles(files:FamilyFileOptions):FamilyHttpOptions {
  try {
    if(files.upstream!=='http://127.0.0.1:19789/v1/responses')fail();
    const token=protectedFile(files.bridgeTokenFile).trim(),upstreamToken=protectedFile(files.upstreamTokenFile).trim();
    if(!/^[A-Za-z0-9_-]{32,256}$/.test(token)||!/^[A-Za-z0-9_-]{32,256}$/.test(upstreamToken))fail();
    const groups=protectedFile(files.groupsFile).trim().split(/\r?\n/);
    if(!groups.length||groups.some(g=>!/^C[0-9a-f]{32}$/.test(g))||new Set(groups).size!==groups.length)fail();
    parents(files.ledgerPath);
    try {const st=lstatSync(files.ledgerPath);if(!st.isFile()||st.nlink!==1||(st.mode&0o077)!==0||st.uid!==process.getuid?.())fail();}
    catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
    return {token,upstreamToken,groups,ledgerPath:files.ledgerPath,upstream:files.upstream};
  }catch{fail();}
}
export function launchFamilyBridge(files:FamilyFileOptions){
  process.umask(0o077);
  return createFamilyBridgeServer(readFamilyBridgeFiles(files)).listen(18791,'127.0.0.1');
}
