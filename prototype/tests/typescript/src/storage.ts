const map = new Map<string, unknown>();
export async function readJsonSafe<T>(p:string,fallback:T,fn:(v:unknown)=>v is T):Promise<{value:T,warning?:string}>{
  if(!map.has(p))return {value:structuredClone(fallback)};
  const obj=map.get(p);
  return fn(obj)?{value:structuredClone(obj)}:{value:fallback,warning:'CORRUPT'};
}
export async function atomicWriteJson(p:string,o:unknown,_m?:number):Promise<void>{map.set(p,structuredClone(o));}
export async function ensurePrivateDir(_p:string):Promise<void>{}
