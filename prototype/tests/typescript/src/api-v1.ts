export function parseRequestId(_x:unknown){return ''}
export function requestFingerprint(_parts:(string|Buffer)[]){return ''}
export function sendResponse(_id:string,_result:unknown){return {status:'confirmed'};}
export class RequestDeduplicator<T>{constructor(_ttl:number,_max?:number){}async run(_id:string,_finger:string,fn:()=>Promise<T>){return {value:await fn()}}}
