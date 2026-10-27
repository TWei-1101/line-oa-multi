let csrf='';
let timezone;
let lineLogoutBusy=false;
let aliases={};
let qrTimer;
let qrPollBusy=false;
let qrImageLoaded=false;
let qrCompletionHandled=false;
let sessionConnected=false;
let logView='general';
const $=id=>document.getElementById(id);
const fmt=t=>t?new Date(t).toLocaleString('zh-TW',timezone?{timeZone:timezone,timeZoneName:'short'}:{timeZoneName:'short'}):'—';

function responseError(data,status){
  const code=data.error_name||(typeof data.error==='string'?data.error:data.error?.code)||data.reason||`HTTP_${status}`;
  return new Error([`${code}（HTTP ${status}${data.upstream_status?`；LINE HTTP ${data.upstream_status}`:''}）`,data.message,data.details].filter(Boolean).join('\n'));
}

async function api(path,options={}){
  const headers={'Content-Type':'application/json',...(options.headers||{})};
  if(csrf&&options.method&&options.method!=='GET')headers['X-CSRF-Token']=csrf;
  const response=await fetch(path,{...options,headers});
  const data=await response.json().catch(()=>({error:'INVALID_RESPONSE'}));
  if(!response.ok)throw responseError(data,response.status);
  return data;
}

async function boot(){
  const state=await api('api/auth/session');
  if(state.authenticated){
    csrf=state.csrfToken;showApp();await refreshAll();await loadSettings();
    await pollQrOnce();
  }else{
    $('loginPanel').hidden=false;$('app').hidden=true;
    if(state.setupRequired)$('loginHint').textContent='尚未設定密碼，請先依 README 執行管理者密碼設定指令。';
  }
}
function showApp(){$('loginPanel').hidden=true;$('app').hidden=false}
async function refreshAll(){await Promise.all([status(),loadAliases(),logs(),loadApiKey(),loadCachedContacts()])}
async function status(){
  const s=await api('api/status');
  timezone=s.timezone;
  sessionConnected=s.session.botIdConfigured&&!['AUTH_REQUIRED','EXPIRED','ERROR'].includes(s.session.state);
  $('accountName').textContent=s.session.accountName||'未設定';$('cacheCount').textContent=s.cacheCount;$('submittedCount').textContent=s.submittedCount;
  $('rss').textContent=`${(s.resources.rssBytes/1048576).toFixed(1)} MB`;$('uptime').textContent=`${Math.floor(s.uptimeSeconds/60)} 分鐘`;
  $('lastLogin').textContent=fmt(s.session.lastLoginAt);$('loginAge').textContent=Number.isFinite(s.session.loginAgeDays)?`${s.session.loginAgeDays} 天前`:'—';
  $('lastValidated').textContent=fmt(s.session.lastValidatedAt);$('lastSubmitted').textContent=fmt(s.lastSubmittedAt);$('latestError').textContent=s.latestError||'無';
  $('sessionReason').textContent=s.session.reason;$('version').textContent=s.version;$('footerVersion').textContent=`v${s.version}`;$('listen').textContent=`${s.settings.host}:${s.settings.port}`;
  $('cacheTtl').textContent=`${s.settings.cacheTtlMs/60000} 分鐘`;$('apiEnabled').textContent=s.settings.apiEnabled?'已配對':'等待配對';$('imageEnabled').textContent=s.settings.imageSendingEnabled?'啟用':'停用';$('logout').hidden=!s.settings.uiAuthEnabled;
  $('logoutLine').hidden=!s.session.botIdConfigured;
  $('logoutLine').disabled=lineLogoutBusy;
  const badge=$('sessionBadge');badge.textContent=s.session.state;badge.className=`badge ${s.session.state==='CONNECTED'?'ok':['AUTH_REQUIRED','VALIDATING'].includes(s.session.state)?'neutral':'bad'}`;
}

function renderQr(state){
  const active=['starting','qr','pin','finalizing','selecting'].includes(state.status);
  $('qrLoginBox').hidden=state.status==='idle';$('startQrLogin').disabled=active;$('cancelQrLogin').hidden=!active;
  const titles={starting:'正在建立安全登入',qr:'掃描 LINE 行動條碼',pin:'在手機確認登入',finalizing:'正在建立 OA Session',selecting:'選擇官方帳號',ok:'登入完成',error:'登入失敗'};
  $('qrLoginTitle').textContent=titles[state.status]||'QR Code 登入';
  $('qrLoginMessage').textContent=[state.error_name||state.message,state.error_name&&state.message!==state.error_name?state.message:'',state.details].filter(Boolean).join('\n');
  $('qrPin').hidden=!state.pin;$('qrPin').textContent=state.pin?`PIN ${state.pin}`:'';
  const choices=$('qrChoices');choices.textContent='';choices.hidden=!state.choices?.length;
  for(const choice of state.choices||[]){const button=document.createElement('button');button.className='secondary';button.textContent=choice.label;button.onclick=async()=>{[...choices.querySelectorAll('button')].forEach(x=>x.disabled=true);try{renderQr(await api('api/session/qr/select',{method:'POST',body:JSON.stringify({choiceId:choice.id})}))}catch(error){renderQr({status:'error',hasQr:false,message:error.message})}};choices.append(button)}
  $('qrImageFrame').hidden=!state.hasQr;
  if(state.hasQr&&!qrImageLoaded){$('qrImage').src=`api/session/qr/image?t=${Date.now()}`;qrImageLoaded=true}
  if(!state.hasQr){$('qrImage').removeAttribute('src');qrImageLoaded=false}
  if(active)startQrPolling();else stopQrPolling();
  if(state.status==='error'){$('qrLoginMessage').className='error';qrCompletionHandled=false}else $('qrLoginMessage').className=state.status==='ok'?'success':'';
  if(state.status==='ok'&&!qrCompletionHandled){
    qrCompletionHandled=true;
    void(async()=>{
      try{await api('api/session/validate',{method:'POST',body:'{}'});sessionConnected=true;$('startQrLogin').disabled=false;$('qrLoginMessage').textContent='登入與 LINE OA 連線驗證成功。'}
      catch(error){$('qrLoginMessage').className='error';$('qrLoginMessage').textContent=`Session 已保存，但連線驗證失敗：${error.message}`}
      await refreshAll();
    })();
  }
}
function startQrPolling(){if(!qrTimer)qrTimer=setInterval(()=>void pollQrOnce(),1000)}
function stopQrPolling(){if(qrTimer){clearInterval(qrTimer);qrTimer=undefined}}
async function pollQrOnce(){
  if(qrPollBusy)return;
  qrPollBusy=true;
  try{const state=await api('api/session/qr/status');if(!lineLogoutBusy)renderQr(state)}catch{}finally{qrPollBusy=false}
}

async function loadAliases(){
  const data=await api('api/aliases');aliases=data.aliases;const select=$('target');const selected=select.value;select.textContent='';const list=$('aliasList');list.textContent='';
  for(const [key,value]of Object.entries(aliases)){
    const option=document.createElement('option');option.value=key;option.textContent=`${key} — ${value.name}`;select.append(option);
    const row=document.createElement('div');row.className='item';const text=document.createElement('div');const name=document.createElement('strong');name.textContent=key;
    const meta=document.createElement('small');meta.textContent=`${value.name} · ${value.chatId}`;text.append(name,document.createElement('br'),meta);
    const remove=document.createElement('button');remove.className='secondary';remove.textContent='移除';remove.onclick=async()=>{if(!confirm(`確定移除允許別名 ${key}？`))return;await api(`api/aliases/${encodeURIComponent(key)}`,{method:'DELETE'});await loadAliases()};
    row.append(text,remove);list.append(row);
  }
  if(!select.children.length){const o=document.createElement('option');o.textContent='請先從聯絡人設定別名';o.value='';select.append(o);list.textContent='尚未設定別名'}
  else if([...select.options].some(o=>o.value===selected))select.value=selected;
  updateTargetInfo();
}
function updateTargetInfo(){const alias=$('target').value;const box=$('targetInfo');box.hidden=!alias;if(!alias)return;$('targetAlias').value=alias;$('targetYaml').textContent=`action: line_oa.send_text\ndata:\n  who: ${alias}\n  message: "洗衣機已完成"`;$('copyStatus').textContent=''}
async function loadContacts(force=false){
  const query=$('contactQuery').value;const data=force?await api('api/contacts/refresh',{method:'POST',body:JSON.stringify({query})}):await api(`api/contacts?query=${encodeURIComponent(query)}`);
  renderContacts(data);await status();
}
async function loadCachedContacts(){
  const data=await api('api/contacts/cache');
  const query=$('contactQuery').value.toLocaleLowerCase();
  renderContacts({...data,list:data.list.filter(c=>c.name.toLocaleLowerCase().includes(query))});
}
function renderContacts(data){
  aliases=data.aliases;const list=$('contactList');list.textContent='';if(!data.list.length){list.textContent='尚無符合的聯絡人；請按「重新整理」從 LINE 載入。';return}
  for(const c of data.list){
    const row=document.createElement('div');row.className='item';const text=document.createElement('div');const name=document.createElement('strong');name.textContent=c.name;
    const meta=document.createElement('small');meta.textContent=`${c.kind==='group'?'群組':'個人'} · ${c.chatId}`;text.append(name,document.createElement('br'),meta);
    const button=document.createElement('button');button.textContent='設為別名';button.onclick=async()=>{const alias=prompt('輸入英數小寫別名（例如 home）');if(!alias)return;try{await api('api/aliases',{method:'PUT',body:JSON.stringify({alias,chatId:c.chatId})});await loadAliases()}catch(e){alert(e.message)}};
    row.append(text,button);list.append(row);
  }
}
async function logs(){
  if(logView==='automatic')return autoLoginLogs();
  const data=await api('api/logs');const list=$('logList');list.textContent='';
  for(const x of data.logs){const row=document.createElement('div');row.className='item';const left=document.createElement('div');const strong=document.createElement('strong');strong.textContent=`${x.operation} · ${x.result}`;const small=document.createElement('small');small.textContent=`${x.localTime||fmt(x.time)}${x.target?' · '+x.target:''}${x.error?' · '+x.error:''}`;left.append(strong,document.createElement('br'),small);if(x.details){const details=document.createElement('details');const summary=document.createElement('summary');summary.textContent='系統回應／除錯詳情';const pre=document.createElement('pre');pre.textContent=x.details;details.append(summary,pre);left.append(details)}row.append(left);list.append(row)}
  if(!data.logs.length)list.textContent='尚無操作紀錄';
}
async function autoLoginLogs(){
  const data=await api('api/auto-login/logs');const list=$('autoLoginLogList');list.textContent='';
  const triggers={scheduled_check:'定時檢查',startup_check:'啟動檢查',manual_check:'手動測試連線',send:'發送訊息',contacts:'讀取聯絡人'};
  const results={STARTED:'進行中',SUCCESS:'成功',FAILED:'失敗',INTERRUPTED:'服務中斷，結果未確認'};
  for(const x of data.logs){
    const row=document.createElement('div');row.className='item';const content=document.createElement('div');
    const title=document.createElement('strong');title.textContent=`${triggers[x.trigger]||x.trigger} · ${results[x.result]||x.result}`;
    title.className=x.result==='SUCCESS'?'success':x.result==='FAILED'?'error':'';
    const timing=document.createElement('small');timing.textContent=`開始：${x.startedLocalTime||fmt(x.startedAt)}`;
    content.append(title,document.createElement('br'),timing);
    if(x.completedAt){const done=document.createElement('small');done.textContent=`結束：${x.completedLocalTime||fmt(x.completedAt)} · 耗時 ${(x.durationMs/1000).toFixed(1)} 秒`;content.append(document.createElement('br'),done)}
    if(x.error){const error=document.createElement('div');error.className='error';error.textContent=x.error;content.append(error)}
    row.append(content);list.append(row);
  }
  if(!data.logs.length)list.textContent='尚無自動登入紀錄。一般檢查未觸發登入時不會新增紀錄。';
}
function selectLogView(view){
  logView=view;$('generalLogHelp').hidden=view!=='general';$('generalLogsPanel').hidden=view!=='general';$('autoLoginLogsPanel').hidden=view!=='automatic';
  for(const [id,name]of [['generalLogsTab','general'],['autoLoginLogsTab','automatic']]){const button=$(id);button.className=name===view?'active':'secondary';button.setAttribute('aria-pressed',String(name===view))}
  logs().catch(error=>alert(error.message));
}
async function loadSettings(){const data=await api('api/settings');$('sessionCheckMinutes').value=data.sessionCheckIntervalMinutes}

async function loadApiKey(){
  const data=await api('api/pairing/status');
  $('pairingState').textContent=data.paired?'已配對':'等待 Home Assistant 確認配對';
  $('hacsState').textContent=data.hacs_connected?'已連線':data.paired?'尚未收到近期請求':'尚未配對';
  $('discoveryState').textContent=data.discovery_status;
}

$('loginForm').onsubmit=async e=>{e.preventDefault();$('loginError').textContent='';try{const data=await api('api/auth/login',{method:'POST',body:JSON.stringify({password:$('password').value})});csrf=data.csrfToken;$('password').value='';showApp();await refreshAll();await loadSettings()}catch(err){$('loginError').textContent=err.message}};
$('logoutLine').onclick=async()=>{
  if(!confirm('確定登出 LINE？將清除此 Add-on 保存的 LINE 登入資料，之後需要重新登入。收件者別名與 Home Assistant 配對會保留。'))return;
  lineLogoutBusy=true;$('logoutLine').disabled=true;$('startQrLogin').disabled=true;$('validateSession').disabled=true;
  try{await api('api/session/logout',{method:'POST',body:'{}'});stopQrPolling();qrCompletionHandled=false;renderQr({status:'idle',hasQr:false});$('contactList').textContent='已登出，重新登入後請按「重新整理」載入聯絡人。';await refreshAll()}
  catch(error){alert(error.message)}finally{lineLogoutBusy=false;$('logoutLine').disabled=false;$('startQrLogin').disabled=false;$('validateSession').disabled=false}
};
$('generalLogsTab').onclick=()=>selectLogView('general');
$('autoLoginLogsTab').onclick=()=>selectLogView('automatic');
$('sessionCheckForm').onsubmit=async event=>{
  event.preventDefault();const result=$('sessionCheckResult');result.textContent='';$('saveSessionCheck').disabled=true;
  try{const data=await api('api/settings',{method:'PUT',body:JSON.stringify({sessionCheckIntervalMinutes:Number($('sessionCheckMinutes').value)})});$('sessionCheckMinutes').value=data.sessionCheckIntervalMinutes;result.className='success';result.textContent=data.sessionCheckIntervalMinutes===0?'已停用定時檢查；發送遇到登入失效時才嘗試自動恢復。':`已設定閒置 ${data.sessionCheckIntervalMinutes} 分鐘再加隨機 1～10 分鐘後檢查；再次發送會重新計時。`}
  catch(error){result.className='error';result.textContent=error.message}finally{$('saveSessionCheck').disabled=false}
};
$('refreshLogs').onclick=()=>logs().catch(error=>alert(error.message));
$('logout').onclick=async()=>{await api('api/auth/logout',{method:'POST',body:'{}'});csrf='';location.reload()};
document.querySelectorAll('nav [data-tab]').forEach(button=>button.onclick=()=>{document.querySelectorAll('nav [data-tab]').forEach(x=>{x.classList.remove('active');x.setAttribute('aria-selected','false')});document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));button.classList.add('active');button.setAttribute('aria-selected','true');$(button.dataset.tab).classList.add('active');if(button.dataset.tab==='logs')logs().catch(e=>alert(e.message));if(button.dataset.tab==='contacts')loadCachedContacts().catch(e=>alert(e.message))});
$('validateSession').onclick=async()=>{try{await api('api/session/validate',{method:'POST',body:'{}'});await status()}catch(e){await status();alert(e.message)}};
$('startQrLogin').onclick=async()=>{qrCompletionHandled=false;renderQr({status:'starting',hasQr:false,message:'正在向 LINE 取得短效 QR Code…'});try{renderQr(await api('api/session/qr/start',{method:'POST',body:'{}'}))}catch(error){renderQr({status:'error',hasQr:false,message:error.message})}};
$('cancelQrLogin').onclick=async()=>{try{renderQr(await api('api/session/qr/cancel',{method:'POST',body:'{}'}))}catch(error){renderQr({status:'error',hasQr:false,message:error.message})}};
$('searchForm').onsubmit=e=>{e.preventDefault();loadContacts(false).catch(e=>alert(e.message))};$('refreshContacts').onclick=()=>loadContacts(true).catch(e=>alert(e.message));
$('target').onchange=updateTargetInfo;$('copyTarget').onclick=async()=>{try{await navigator.clipboard.writeText($('targetAlias').value);$('copyStatus').textContent='已複製 target 別名。'}catch{$('targetAlias').select();$('copyStatus').textContent='無法自動複製，請手動複製已選取的內容。'}};
$('resetPairing').onclick=async()=>{if(!confirm('重新配對會立即撤銷舊 API 憑證。請接著在 Home Assistant 的 LINE OA 整合按「重新驗證」完成配對。'))return;try{await api('api/pairing/reset',{method:'POST',body:'{}'});await loadApiKey()}catch(error){alert(error.message)}};
$('sendForm').onsubmit=async e=>{e.preventDefault();const button=$('sendButton');button.disabled=true;$('sendResult').textContent='送出中…';try{const result=await api('api/messages/send',{method:'POST',body:JSON.stringify({target:$('target').value,message:$('message').value})});$('sendResult').className=result.result==='SUBMITTED'?'success':'error';$('sendResult').textContent=result.result==='SUBMITTED'?'發送成功':`${result.result}：不可自動重送。`;$('message').value='';await status()}catch(err){$('sendResult').className='error';$('sendResult').textContent=err.message}finally{button.disabled=false}};
$('imageForm').onsubmit=async e=>{e.preventDefault();const button=$('imageButton');const file=$('imageFile').files[0];const target=$('target').value;if(!file||!target)return;button.disabled=true;$('imageResult').className='';$('imageResult').textContent='圖片上傳與發送中…';try{const response=await fetch(`api/messages/image?target=${encodeURIComponent(target)}`,{method:'POST',headers:{'Content-Type':file.type,'X-CSRF-Token':csrf},body:file});const result=await response.json().catch(()=>({error:'INVALID_RESPONSE'}));if(!response.ok)throw responseError(result,response.status);$('imageResult').className=result.result==='SUBMITTED'?'success':'error';$('imageResult').textContent=result.result==='SUBMITTED'?'發送成功':`${result.result}：不可自動重送。`;if(result.result==='SUBMITTED')$('imageFile').value='';await status()}catch(err){$('imageResult').className='error';$('imageResult').textContent=err.message}finally{button.disabled=false}};
boot().catch(e=>{$('loginPanel').hidden=false;$('loginError').textContent=e.message});

setInterval(()=>{void status().catch(()=>{});void loadApiKey().catch(()=>{});},30000);
