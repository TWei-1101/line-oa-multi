/** Runnable HTTP boundary; deployment requires the separately approved TLS/tunnel. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { FamilyBridge, FamilyBridgeError, FAMILY_MAX_BYTES } from './family-bridge.js';
export type FamilyHttpOptions = { token:string; groups:readonly string[]; ledgerPath:string; upstream?:string; upstreamToken?:string; fetch?:typeof fetch;
  /** Trusted dependency seams for bounded offline tests, never caller fields. */
  now?:()=>number; requestTimeoutMs?:number; upstreamTimeoutMs?:number };
function reply(res:ServerResponse,status:number,body:Record<string,unknown>):void {
  if(res.destroyed)return;
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(body));
}
async function body(req:IncomingMessage,timeout:number):Promise<unknown> {
  const timer=setTimeout(()=>req.destroy(),timeout);timer.unref();
  const chunks:Buffer[]=[];let n=0;
  try {
    for await(const part of req){n+=(part as Buffer).length;if(n>FAMILY_MAX_BYTES)throw new FamilyBridgeError('FAMILY_BODY_TOO_LARGE',413);chunks.push(part as Buffer);}
    try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}
    catch{throw new FamilyBridgeError('FAMILY_INVALID_JSON');}
  }finally{clearTimeout(timer);}
}
export function createFamilyBridgeServer(options:FamilyHttpOptions):Server {
  const bridge=new FamilyBridge(options),rate=new Map<string,number[]>(),clock=options.now??Date.now;
  const server=createServer(async(req,res)=>{
    try {
      const url=new URL(req.url??'/','http://localhost');
      if(url.pathname!=='/v1/responses'||url.search)return reply(res,404,{error:'NOT_FOUND'});
      if(req.method!=='POST')return reply(res,405,{error:'METHOD_NOT_ALLOWED'});
      if(Object.keys(req.headers).some(h=>h.startsWith('x-openclaw-')))return reply(res,400,{error:'FAMILY_ROUTING_HEADER'});
      for(const name of ['authorization','content-type'])if(req.rawHeaders.filter((h,i)=>i%2===0&&h.toLowerCase()===name).length>1)return reply(res,400,{error:'FAMILY_DUPLICATE_HEADER'});
      const auth=req.headers.authorization;
      if(!auth?.startsWith('Bearer ')||auth.length<=7)return reply(res,401,{error:'FAMILY_UNAUTHORIZED'});
      bridge.authenticate(auth.slice(7)); // Before reading body, parsing JSON or consuming authenticated quota.
      if((req.headers['content-type']??'').split(';')[0].trim().toLowerCase()!=='application/json')return reply(res,415,{error:'FAMILY_CONTENT_TYPE'});
      const now=clock(),ip=req.socket.remoteAddress??'';
      for(const [key,hits] of rate)if(!hits.length||now-hits[hits.length-1]!>=60000)rate.delete(key);
      const hits=(rate.get(ip)??[]).filter(x=>now-x<60000);
      if(hits.length>=60||(!rate.has(ip)&&rate.size>=4096))return reply(res,429,{error:'FAMILY_RATE_LIMIT'});
      hits.push(now);rate.set(ip,hits);
      const result=await bridge.dispatch(await body(req,options.requestTimeoutMs??15000),auth.slice(7));reply(res,200,result);
    }catch(e){const x=e instanceof FamilyBridgeError?e:new FamilyBridgeError('FAMILY_INTERNAL',500);reply(res,x.status,{error:x.code});}
  });
  server.headersTimeout=15000;server.requestTimeout=15000;
  server.on('close',()=>bridge.close());return server;
}
