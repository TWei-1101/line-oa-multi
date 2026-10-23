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
    const currentWebhook=account.webhook||{};
    const webhookButton=label('button',currentWebhook.enabled?'停用 Webhook':currentWebhook.configured?'啟用 Webhook':'Webhook 設定');webhookButton.type='button';
    webhookButton.className='secondary';
    webhookButton.addEventListener('click',async()=>{
      const current=account.webhook||{};
      if(current.enabled){
        if(!confirm(`確定停用 ${account.id} 的官方 LINE Webhook？`))return;
        webhookButton.disabled=true;
        try{
          await request(`api/accounts/${encodeURIComponent(account.id)}/webhook`,{method:'PUT',body:JSON.stringify({enabled:false})});
          el('feedback').textContent=`${account.id} Webhook 已停用`;
          await reload();
        }catch(e){el('feedback').textContent=`Webhook 停用失敗：${e.message}`;}
        finally{webhookButton.disabled=false;}
        return;
      }
      const raw=prompt(`帳號 ${account.id} 的 Channel Secret\n請輸入新 Secret；留空表示沿用已設定的 Secret。\n目前：${current.configured?'已設定':'未設定'}`,'');
      if(raw===null)return;
      webhookButton.disabled=true;
      try{
        const body={enabled:true};
        if(raw.trim())body.channel_secret=raw.trim();
        await request(`api/accounts/${encodeURIComponent(account.id)}/webhook`,{method:'PUT',body:JSON.stringify(body)});
        el('feedback').textContent=`${account.id} Webhook 設定已儲存`;
        await reload();
      }catch(e){el('feedback').textContent=`Webhook 設定失敗：${e.message}`;}
      finally{webhookButton.disabled=false;}
    });
    meta.append(label('p',`Webhook：${account.webhook?.enabled?'已啟用':account.webhook?.configured?'已設定／停用':'未設定'}`));
    const clawButton=label('button','OpenClaw 設定');clawButton.type='button';clawButton.className='secondary';
    clawButton.addEventListener('click',()=>openAccountBridge(account.id).catch(e=>{el('feedback').textContent=e.message;}));
    actions.append(manage,webhookButton,clawButton,del);card.append(meta,actions);list.append(card);
  }
}
async function boot(){
  try{
    const auth=await request('api/auth/session');
    if(!auth.authenticated)throw new Error('未取得 Home Assistant Ingress 管理身分');
    csrf=auth.csrfToken;
    await reload();
    await reloadBridge();
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

let saveBridge;
function field(parent,text,type='text',value=''){
  const wrapper=label('label',text),input=document.createElement('input');
  input.type=type;input.value=value;input.autocomplete='off';wrapper.append(input);parent.append(wrapper);return input;
}
function showBridge(title){
  el('claw-title').textContent=title;el('claw-fields').replaceChildren();el('claw-error').textContent='';el('claw-dialog').showModal();return el('claw-fields');
}
el('claw-cancel').addEventListener('click',()=>el('claw-dialog').close());
el('claw-form').addEventListener('submit',async event=>{
  event.preventDefault();event.submitter.disabled=true;
  try{await saveBridge();el('claw-dialog').close();await reloadBridge();}
  catch(e){el('claw-error').textContent=e.message;}
  finally{event.submitter.disabled=false;}
});
el('claw-settings').addEventListener('click',async()=>{
  try{
    const cfg=await request('api/openclaw');const parent=showBridge('OpenClaw 連線設定');
    const url=field(parent,'Mac 端 API 網址（結尾 /v1/responses）','url',cfg.url);url.required=true;
    url.placeholder='http://192.168.1.50:18790/v1/responses';
    const token=field(parent,`連線密鑰（${cfg.token_configured?'已設定；留空沿用':'尚未設定'}）`,'password');
    const agent=field(parent,'Agent ID','text',cfg.agent);agent.required=true;
    const timeout=field(parent,'等待完整回答秒數','number',String(cfg.timeout_seconds));timeout.min='30';timeout.max='1800';timeout.required=true;
    parent.append(label('p','網址填 Mac 區網 IP，不能填 localhost。使用 Mac 圖片橋接時預設連接埠為 18790；直接連 OpenClaw 通常為 18789。'));
    saveBridge=()=>request('api/openclaw',{method:'PUT',body:JSON.stringify({url:url.value.trim(),agent:agent.value.trim(),timeout_seconds:Number(timeout.value),...(token.value?{token:token.value}:{})})});
  }catch(e){el('feedback').textContent=e.message;}
});
async function openAccountBridge(id){
  const data=await request(`api/accounts/${encodeURIComponent(id)}/openclaw`);
  const cfg=data.accounts[id]||{enabled:false,routes:[]};const parent=showBridge(`${id} → OpenClaw`);
  const enabled=field(parent,'啟用自動回覆','checkbox');enabled.checked=cfg.enabled;
  for(const [action,text] of [['pause','暫停並排空 Worker'],['resume','繼續 Worker']]){const button=label('button',text);button.type='button';button.onclick=async()=>{button.disabled=true;try{await request('api/openclaw/worker',{method:'POST',body:JSON.stringify({action})});el('feedback').textContent=action==='pause'?'Worker 已排空並暫停':'Worker 已恢復';}catch(e){el('claw-error').textContent=e.message;}finally{button.disabled=false;}};parent.append(button);}
  const token=field(parent,`LINE Channel Access Token（下載收到的圖片用；${cfg.channel_access_token_configured?'已設定，留空沿用':'未設定'}）`,'password');
  const clear=field(parent,'清除已儲存的 LINE Token','checkbox');
  parent.append(label('p','只處理下方綁定的來源。先從 LINE 傳送訊息到 HA，再按重新開啟本設定，可從最近來源選取 ID。群組來源代表整個群組。'));
  const rows=document.createElement('div');parent.append(rows);
  const list=document.createElement('datalist');list.id='source-ids';
  for(const source of data.sources){const option=document.createElement('option');option.value=source.source_id;option.label=source.source_type;list.append(option);}parent.append(list);
  function addRoute(route={source_type:'user',source_id:'',who:''}){
    const row=document.createElement('div');row.className='route';
    const kind=document.createElement('select');
    for(const [value,text] of [['user','私人對話'],['group','群組'],['room','多人聊天室']]){const o=label('option',text);o.value=value;kind.append(o);}kind.value=route.source_type;
    row.append(label('label','來源類型'),kind);
    const source=field(row,'LINE Webhook 來源 ID','text',route.source_id);source.setAttribute('list','source-ids');source.required=true;
    const alias=document.createElement('select');alias.required=true;
    const empty=label('option','請選擇 OA 聯絡人別名');empty.value='';alias.append(empty);
    for(const a of data.aliases){const o=label('option',`${a.alias}（${a.name}）`);o.value=a.alias;alias.append(o);}alias.value=route.who;
    row.append(label('label','回答發送至'),alias);
    const remove=label('button','移除此綁定');remove.type='button';remove.className='secondary';remove.onclick=()=>row.remove();row.append(remove);
    row.readRoute=()=>({source_type:kind.value,source_id:source.value.trim(),who:alias.value});rows.append(row);
  }
  cfg.routes.forEach(addRoute);
  const add=label('button','新增來源綁定');add.type='button';add.onclick=()=>addRoute();parent.append(add);
  if(!data.aliases.length)parent.append(label('p','請先在「管理／登入」中為收件人建立別名，再回到這裡綁定。'));
  let familySave=()=>({});
  if(id==='family'){
    parent.append(label('h3','Family 專用端點（預設停用）'));
    const expected=field(parent,'預期 Family Bot destination（由管理者確認，非從封包學習）','text',cfg.expected_destination||'');
    const override=field(parent,'使用 Family 專用端點','checkbox');override.checked=cfg.endpoint?.mode==='override';
    const endpointUrl=field(parent,'Family API 網址','url',cfg.endpoint?.url||'');
    const endpointToken=field(parent,'Family Bridge Token（'+(cfg.endpoint?.token_configured?'已設定，留空沿用':'尚未設定')+'）','password');
    const endpointAgent=field(parent,'固定 Agent','text',cfg.endpoint?.agent||'family-line');
    const endpointTimeout=field(parent,'Family 等待秒數','number',String(cfg.endpoint?.timeout_seconds||30));
    const protocol=document.createElement('select');const proto=label('option','family-text-v1');proto.value='family-text-v1';protocol.append(proto);parent.append(label('label','Family Protocol'),protocol);
    const admission=document.createElement('select');for(const [v,t] of [
      ['legacy','一般模式（不可啟用 Family）'],
      ['self-mention-group-text','僅群組 @Bot 文字（預設）'],
      ['keyword-prefix','文字喚醒詞（喵／助理喵／小貓等開頭）'],
      ['followup-window','追問窗口（@Bot 後 3 分鐘免 Tag）'],
      ['keyword-or-followup','喚醒詞 ＋ 追問窗口（最推薦 ⭐）'],
      ['smart-intent','智慧意圖過濾（疑問句＋喚醒詞＋追問）']
    ]){const o=label('option',t);o.value=v;admission.append(o);}admission.value=cfg.admission||'legacy';parent.append(label('label','Family Admission'),admission);
    parent.append(label('p','支援：僅 @Bot 文字、文字開頭喚醒詞、對話延續免 Tag 追問，或智慧意圖過濾。可依家庭使用習慣隨時切換。'));
    familySave=()=>({expected_destination:expected.value.trim(),admission:admission.value,endpoint:override.checked?{mode:'override',url:endpointUrl.value.trim(),agent:endpointAgent.value.trim(),timeout_seconds:Number(endpointTimeout.value),protocol:'family-text-v1',...(endpointToken.value?{token:endpointToken.value}:{})}:{mode:'inherit'}});
  }
  saveBridge=()=>request('api/accounts/'+encodeURIComponent(id)+'/openclaw',{method:'PUT',body:JSON.stringify({...familySave(),enabled:enabled.checked,routes:[...rows.children].map(row=>row.readRoute()),...(clear.checked?{channel_access_token:''}:token.value?{channel_access_token:token.value}:{})})});
}
async function reloadBridge(){
  const data=await request('api/openclaw'),c=data.counts;
  el('claw-status').textContent=`${data.url?'已設定連線':'尚未設定連線'} · 待處理 ${c.pending+c.generating+c.ready+c.sending} · 已提交 ${c.submitted} · 待確認 ${c.unknown} · 失敗 ${c.failed}${data.fault?' · '+data.fault:''}`;
  const parent=el('claw-jobs');parent.replaceChildren();
  const names={pending:'等待處理',generating:'OpenClaw 處理中',ready:'待發送',sending:'發送中',submitted:'已提交 LINE（不等於已讀／送達）',unknown:'發送結果不確定',failed:'失敗／待處理',ignored:'已略過'};
  for(const job of data.jobs.slice(0,30)){
    const row=label('div',`${job.account} → ${job.who} · ${names[job.state]} · ${job.next_part}/${job.total_parts} 段${job.error?' · '+job.error:''}`);row.className='job';
    if(['failed','unknown'].includes(job.state)){
      for(const [action,text] of [['retry','重試'],['skip','略過此工作'],...(job.state==='unknown'?[['mark_submitted','已確認本段送出']]:[])]){
        const button=label('button',text);button.type='button';button.className='secondary';
        button.onclick=async()=>{
          const warning=action==='retry'?'重試可能重複執行 OpenClaw 工具或重複發送，請先確認對話與日誌。':action==='skip'?'略過後不再處理此工作；同一對話的後續訊息將繼續。':'請先在 LINE 確認目前這一段已送出，系統將從下一段繼續。';
          if(!confirm(warning))return;
          try{await request(`api/openclaw/jobs/${job.id}`,{method:'POST',body:JSON.stringify({action})});await reloadBridge();}catch(e){el('feedback').textContent=e.message;}
        };row.append(button);
      }
    }parent.append(row);
  }
}
el('claw-refresh').addEventListener('click',()=>reloadBridge().catch(e=>{el('feedback').textContent=e.message;}));
