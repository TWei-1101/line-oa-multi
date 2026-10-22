import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageSender } from '../src/sender.js';
import { MemoryLogger } from '../src/logger.js';
import type { LineClient } from '../src/line-client.js';
import type { SessionManager } from '../src/session.js';
import type { ContactService } from '../src/contacts.js';
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};}
for(const image of [false,true])test('actual MessageSender '+(image?'image':'text')+' compares before await and captures primitive across validate',async()=>{
 const target={chatId:'original-oa-chat',name:'original'};const entered=deferred(),release=deferred();const sent:string[]=[];
 const client={validate:async()=>{entered.resolve();await release.promise;},sendText:async(id:string)=>{sent.push(id);return {result:'SUBMITTED',sendId:'x'};},sendImage:async(id:string)=>{sent.push(id);return {result:'SUBMITTED',sendId:'x'};}};
 const sender=new MessageSender(client as unknown as LineClient,{mark:()=>{}} as unknown as SessionManager,{resolve:()=>target} as unknown as ContactService,new MemoryLogger(),1000,20);
 const run=()=>image?sender.sendImage('family',Buffer.from('fake'),'image/png','original-oa-chat'):sender.send('family','hello','original-oa-chat');
 target.chatId='replacement';await assert.rejects(run,/TARGET_CHANGED/);assert.deepEqual(sent,[]);
 target.chatId='original-oa-chat';const task=run();await entered.promise;target.chatId='replacement';release.resolve();await task;
 assert.deepEqual(sent,['original-oa-chat']);
});
