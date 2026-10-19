'use strict';
let csrf = '';
const el = id => document.getElementById(id);
const label = (id,text) => { const e=document.createElement(id);e.textContent=text;return e; };
async function request(path, opts={}){
  const headers={'Content-Type':'application/json', ...(opts.headers||{})};
  if(opts.method && opts.method!=='GET') headers['X-CSRF-Token']=csrf;
  const r=await fetch(path,{...opts,headers});
  const data=await r.json().catch(()=>({error:'INVALID_RESPONSE'}));
  if(!r.ok)throw new Error((typeof data.error==='string'?data.error:data.error?.code)||`HTTP ${r.status}`);
  return data;
}
async function reload(){
  const data=await request('api/accounts');
  const list=el('accounts');list.replaceChildren();
  el('connection').textContent=`${data.accounts.filter(a=>a.logged_in).length}/${data.accounts.length} 已連線`;
  if(!data.accounts.length)list.append(label('p','尚未建立任何 LINE OA 帳號。請使用上方欄位新增。'));
  for(const account of data.accounts){
    const card=label('article','');card.className='account';card.setAttribute('role','listitem');
    const meta=label('div','');
    meta.append(label('h3',account.id), label('p',`${account.account_name||'尚未選擇官方帳號'} · ${account.session_status}`));
    const actions=label('div','');actions.className='account-actions';
    const manage=label('a','管理／登入');manage.className='link';
    manage.href=`accounts/${encodeURIComponent(account.id)}/`;
    const del=label('button','刪除');del.type='button';del.className='secondary';
    del.addEventListener('click',async()=>{
      if(!confirm(`確定刪除 ${account.id}？這會永久刪除它的 LINE Session、聯絡人別名與本機快取。`))return;
      del.disabled=true;
      try{await request(`api/accounts/${encodeURIComponent(account.id)}`,{method:'DELETE'});
          el('feedback').textContent=`已刪除 ${account.id}`;await reload();}
      catch(e){el('feedback').textContent=e.message;del.disabled=false;}
    });
    const webhookButton=label('button','Webhook 設定');webhookButton.type='button';
    webhookButton.className='secondary';
    webhookButton.addEventListener('click',async()=>{
      const current=account.webhook||{};
      const raw=prompt(`帳號 ${account.id} 的 Channel Secret\n請輸入新 Secret；留空表示沿用已設定的 Secret。\n目前：${current.configured?'已設定':'未設定'}`,'');
      if(raw===null)return;
      const enabled=confirm(`是否啟用 ${account.id} 的官方 LINE Webhook？\n確定＝啟用，取消＝停用。`);
      webhookButton.disabled=true;
      try{
        const body={enabled};
        if(raw.trim())body.channel_secret=raw.trim();
        await request(`api/accounts/${encodeURIComponent(account.id)}/webhook`,{method:'PUT',body:JSON.stringify(body)});
        el('feedback').textContent=`${account.id} Webhook 設定已儲存`;
        await reload();
      }catch(e){el('feedback').textContent=`Webhook 設定失敗：${e.message}`;}
      finally{webhookButton.disabled=false;}
    });
    meta.append(label('p',`Webhook：${account.webhook?.enabled?'已啟用':account.webhook?.configured?'已設定／停用':'未設定'}`));
    actions.append(manage,webhookButton,del);card.append(meta,actions);list.append(card);
  }
}
async function boot(){
  try{
    const auth=await request('api/auth/session');
    if(!auth.authenticated)throw new Error('未取得 Home Assistant Ingress 管理身分');
    csrf=auth.csrfToken;
    await reload();
  }catch(e){el('feedback').textContent=`初始化失敗：${e.message}`;}
}
el('add').addEventListener('submit',async event=>{
  event.preventDefault();
  const field=el('id');const name=field.value.trim();
  const button=event.submitter;button.disabled=true;
  try{
    await request('api/accounts',{method:'POST',body:JSON.stringify({id:name})});
    field.value='';el('feedback').textContent=`已建立 ${name}，請點「管理／登入」掃 QR Code。`;
    await reload();
  }catch(e){el('feedback').textContent=`建立失敗：${e.message}`;}
  finally{button.disabled=false;}
});
void boot();
