/** Optional Mac adapter. Run with Node 24: node openclaw-mac.ts
 * Secrets are environment variables; no request bodies or tokens are logged.
 * Converts local MEDIA:/Markdown image references to inline image response parts.
 */
import http from 'node:http';
import { open, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';

type Part = Record<string,unknown>;
const MAX_BYTES=32*1024*1024,MAX_IMAGE=10*1024*1024;
function sameSecret(actual: string, expected: string): boolean {
  const a=Buffer.from(actual),b=Buffer.from(expected);
  return a.length===b.length && timingSafeEqual(a,b);
}
async function inlineImage(path: string, root: string): Promise<Part> {
  path=path.trim();
  if ((path.startsWith('"') && path.endsWith('"')) || (path.startsWith("'") && path.endsWith("'"))) path=path.slice(1,-1);
  if(path.startsWith('file:'))path=fileURLToPath(path);
  if(path.startsWith('~/'))path=join(homedir(),path.slice(2));
  const base=await realpath(root),target=await realpath(resolve(base,path));
  const rel=relative(base,target);
  if(!rel || rel==='..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel))throw new Error('MEDIA_OUTSIDE_ALLOWED_ROOT');
  const handle=await open(target,'r');
  let bytes:Buffer;
  try{
    const stat=await handle.stat();
    if(!stat.isFile() || stat.size>MAX_IMAGE)throw new Error('MEDIA_SIZE_LIMIT');
    bytes=await handle.readFile();
    if(bytes.length>MAX_IMAGE)throw new Error('MEDIA_SIZE_LIMIT');
  }finally{await handle.close();}
  const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpeg=bytes[0]===255 && bytes[1]===216 && bytes[2]===255;
  if(!png && !jpeg)throw new Error('MEDIA_TYPE_NOT_SUPPORTED');
  return {type:'output_image',image_url:`data:${png?'image/png':'image/jpeg'};base64,${bytes.toString('base64')}`};
}
export async function inlineMedia(response: Record<string,unknown>, root: string): Promise<Record<string,unknown>> {
  if(response.status!=='completed' || !Array.isArray(response.output))return response;
  const result=structuredClone(response);
  for(const item of result.output as Part[]){
    if(item.type!=='message' || item.role!=='assistant' || !Array.isArray(item.content))continue;
    const parts:Part[]=[];
    for(const part of item.content as Part[]){
      if(part.type!=='output_text' || typeof part.text!=='string'){parts.push(part);continue;}
      const text=part.text;
      // A JSON manifest survives OpenClaw's text-only HTTP projection even when
      // its internal channel handling consumes MEDIA: directives separately.
      if(text.includes('"line_oa_reply"')){
        const raw=text.trim().replace(/^```(?:json)?\s*\n/,'').replace(/\n```$/,'');
        const manifest=JSON.parse(raw) as {line_oa_reply?:Part[]};
        if(!Array.isArray(manifest.line_oa_reply) || !manifest.line_oa_reply.length || manifest.line_oa_reply.length>200)throw new Error('INVALID_REPLY_MANIFEST');
        for(const entry of manifest.line_oa_reply){
          if(entry.type==='text' && typeof entry.text==='string')parts.push({type:'output_text',text:entry.text});
          else if(entry.type==='image' && typeof entry.path==='string')parts.push(await inlineImage(entry.path,root));
          else throw new Error('UNSUPPORTED_REPLY_MANIFEST_PART');
        }
        continue;
      }
      const pattern=/(?:^|(?<=\n))[ \t]*MEDIA:[ \t]*([^\r\n]+)|!\[[^\]]*\]\(([^\r\n)]+)\)/g;
      let cursor=0;
      for(const match of text.matchAll(pattern)){
        if(match.index>cursor)parts.push({type:'output_text',text:text.slice(cursor,match.index)});
        parts.push(await inlineImage(match[1]??match[2]!,root));
        cursor=match.index+match[0].length;
      }
      if(cursor<text.length)parts.push({type:'output_text',text:text.slice(cursor)});
    }
    item.content=parts;
  }
  if(Buffer.byteLength(JSON.stringify(result))>MAX_BYTES)throw new Error('MEDIA_RESPONSE_TOO_LARGE');
  return result;
}
type AdapterOptions={gatewayUrl:string;gatewayToken:string;bridgeToken:string;mediaRoot:string;timeoutMs?:number;fetcher?:typeof fetch};
export function createMacAdapter(options:AdapterOptions): http.Server {
  const base=new URL(options.gatewayUrl);
  if(!['http:','https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash ||
    base.pathname!=='/' || !options.bridgeToken || options.bridgeToken.length<32 || !options.gatewayToken ||
    /[\r\n\0]/.test(options.gatewayToken))throw new Error('INVALID_ADAPTER_CONFIG');
  const endpoint=new URL('/v1/responses',base);
  const fetcher=options.fetcher??fetch;
  const server=http.createServer(async(req,res)=>{
    const reply=(status:number,data:unknown)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
    if(req.headers.origin || !sameSecret(String(req.headers.authorization??''),`Bearer ${options.bridgeToken}`))return reply(401,{error:'UNAUTHORIZED'});
    if(req.url!=='/v1/responses' || req.method!=='POST')return reply(404,{error:'NOT_FOUND'});
    if(!String(req.headers['content-type']).startsWith('application/json'))return reply(415,{error:'JSON_REQUIRED'});
    const controller=new AbortController();
    res.once('close',()=>{if(!res.writableFinished)controller.abort();});
    try{
      let size=0;const chunks:Buffer[]=[];
      for await(const chunk of req){size+=chunk.length;if(size>20*1024*1024)return reply(413,{error:'REQUEST_TOO_LARGE'});chunks.push(Buffer.from(chunk));}
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(!body || typeof body!=='object' || Array.isArray(body) || body.stream===true)return reply(400,{error:'NON_STREAMING_JSON_REQUIRED'});
      body.instructions=[typeof body.instructions==='string'?body.instructions:'',
        'Your final answer is relayed to LINE by an external bridge. Do not use LINE/channel message tools to send it.',
        'Return the entire final answer as a JSON object, without Markdown fences: {"line_oa_reply":[{"type":"text","text":"your complete answer"}]}.',
        `If you create images, save JPEG/PNG files under ${options.mediaRoot} and include ordered {"type":"image","path":"absolute file path"} parts in line_oa_reply.`,
        'Include all answer text and image paths; do not replace your answer with a summary or use MEDIA: directives.'].filter(Boolean).join('\n');
      const headers:Record<string,string>={'Content-Type':'application/json',Authorization:`Bearer ${options.gatewayToken}`};
      for(const key of ['x-openclaw-agent-id','x-openclaw-session-key']){
        const v=req.headers[key];if(typeof v==='string' && v.length<512)headers[key]=v;
      }
      let upstream:Response;
      try{
        upstream=await fetcher(endpoint,{method:'POST',headers,body:JSON.stringify(body),redirect:'error',
          signal:AbortSignal.any([controller.signal,AbortSignal.timeout(options.timeoutMs??1800_000)])});
      }catch(e){
        const code=(e as {cause?:{code?:string}})?.cause?.code;
        if(['ECONNREFUSED','ENOTFOUND','EAI_AGAIN','ENETUNREACH','EHOSTUNREACH','UND_ERR_CONNECT_TIMEOUT'].includes(code??'')){
          res.setHeader('x-line-oa-retry-safe','before-agent');return reply(503,{error:'OPENCLAW_CONNECT_UNAVAILABLE'});
        }
        throw e;
      }
      if(!upstream.ok){await upstream.body?.cancel();return reply(upstream.status,{error:'OPENCLAW_UPSTREAM_REJECTED'});}
      const reader=upstream.body?.getReader();if(!reader)throw new Error('EMPTY_RESPONSE');
      const output:Buffer[]=[];let total=0;
      try{while(true){const {value,done}=await reader.read();if(done)break;total+=value.length;
        if(total>MAX_BYTES){await reader.cancel();throw new Error('RESPONSE_TOO_LARGE');}output.push(Buffer.from(value));}
      }finally{reader.releaseLock();}
      const data=JSON.parse(Buffer.concat(output).toString('utf8'));
      return reply(200,await inlineMedia(data,options.mediaRoot));
    }catch{
      // An agent may already have run. 502 makes the Add-on retain for review,
      // rather than rerunning tools automatically after a lost result.
      if(!res.destroyed)return reply(502,{error:'OPENCLAW_OR_MEDIA_PROCESSING_FAILED'});
    }
  });
  server.requestTimeout=60_000;server.headersTimeout=10_000;
  return server;
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    const server=createMacAdapter({gatewayUrl:process.env.OPENCLAW_GATEWAY_URL??'http://127.0.0.1:18789',
      gatewayToken:process.env.OPENCLAW_GATEWAY_TOKEN??'',bridgeToken:process.env.LINE_OA_BRIDGE_TOKEN??'',
      mediaRoot:process.env.LINE_OA_MEDIA_ROOT??join(homedir(),'.openclaw','workspace')});
    const port=Number(process.env.LINE_OA_BRIDGE_PORT??18790);
    if(!Number.isInteger(port) || port<1 || port>65535)throw new Error('INVALID_PORT');
    server.on('error',()=>{process.stderr.write('LINE OA Mac adapter listener failed.\n');process.exitCode=1;});
    server.listen(port,process.env.LINE_OA_BRIDGE_BIND??'127.0.0.1',()=>process.stdout.write('LINE OA Mac adapter ready.\n'));
    for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{server.close();server.closeAllConnections();});
  }catch{process.stderr.write('LINE OA Mac adapter requires valid gateway and bridge configuration.\n');process.exitCode=1;}
}
