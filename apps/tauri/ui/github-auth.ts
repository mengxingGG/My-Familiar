import type {MobileBridge,MobileGithubAuth,MobileGithubCommands} from '../../../packages/mobile-contracts/index.ts';
type Confirm={title:string;body:string;confirmLabel:string;action:()=>Promise<unknown>;done:string;tone?:'danger'|'primary'};
const element=<K extends keyof HTMLElementTagNameMap>(tag:K,text='',className='')=>{const n=document.createElement(tag);n.textContent=text;n.className=className;return n;};
const button=(text:string,click:()=>void)=>{const b=element('button',text,'quiet');b.type='button';b.addEventListener('click',click);return b;};

/** 登录等待属于 Runtime；关闭此面板只停止状态轮询，不取消登录。 */
export class GithubAuthPanel {
 readonly node=element('section','','github-auth');
 private readonly settings=element('details');
 private readonly client=element('input');
 private readonly save:HTMLButtonElement;
 private readonly begin:HTMLButtonElement;
 private readonly open:HTMLButtonElement;
 private readonly cancel:HTMLButtonElement;
 private readonly forget:HTMLButtonElement;
 private readonly apply:HTMLButtonElement;
 private readonly state=element('p','','block-hint');
 private readonly code=element('code','','github-user-code');
 private readonly deadline=element('p','','block-hint');
 private readonly error=element('p','','form-status');
 private readonly waiting=element('div');
 private status?:MobileGithubAuth;
 private active=false;
 private parentLocked=false;
 private busy=false;
 private edited=false;
 private polling=false;
 private ticket=0;
 private timer?:ReturnType<typeof setInterval>;
 constructor(private bridge:MobileBridge,private confirm:(spec:Confirm)=>void,private commit:(s:MobileGithubAuth)=>Promise<MobileGithubAuth>,private busyChanged:(busy:boolean)=>void,private changed:()=>void){
  this.client.type='text';this.client.maxLength=100;this.client.autocomplete='off';this.client.spellcheck=false;this.client.setAttribute('aria-label','GitHub 登录应用 Client ID');
  this.client.addEventListener('input',()=>{this.edited=!this.status||this.client.value.trim()!==this.status.clientId;this.render();});
  this.client.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();if(!this.save.disabled)this.save.click();}});
  const field=element('label');field.append(element('span','GitHub 登录应用 Client ID','field-label'),this.client);
  this.save=button('保存登录应用',()=>{
   const s=this.status;if(!s)return;const next=this.client.value.trim();
   if(next&&!/^[A-Za-z0-9_.-]{1,100}$/.test(next)){this.fail('请填写 GitHub 应用页面提供的 Client ID。');return;}
   const action=async()=>{await this.run('github.auth.configure',{revision:s.revision,clientId:next});this.edited=false;this.settings.open=false;this.render();};
   if(s.connected||s.user||s.configurationError)this.confirm({title:'更换 GitHub 登录应用？',body:`当前：${s.clientId||'未设置'}\n更换为：${next||'清空'}\n这会清除此设备保存的 GitHub 登录，并断开使用该登录的工具。`,confirmLabel:'更换并清除旧登录',action,done:'登录应用已保存',tone:'danger'});
   else void action().catch(()=>{});
  });
  this.settings.append(element('summary','登录应用设置'),element('p','首次使用需填写已启用 Device Flow 的 GitHub 应用 Client ID，不需要 Client Secret。','block-hint'),field,this.save);
  this.begin=button('获取 GitHub 验证码',()=>{if(this.status)void this.run('github.auth.begin',{revision:this.status.revision}).catch(()=>{});});
  this.open=button('复制验证码并打开 GitHub',()=>{if(this.status)void this.run('github.auth.open',{revision:this.status.revision}).catch(()=>{});});
  this.cancel=button('取消本次登录',()=>{if(this.status)void this.run('github.auth.cancel',{revision:this.status.revision}).catch(()=>{});});
  this.forget=button('清除此设备的 GitHub 登录',()=>{
   const s=this.status;if(!s)return;
   this.confirm({title:'清除此设备的 GitHub 登录？',body:`账号：${s.user?.login??'已保存的 GitHub 登录'}\n只清除此设备的登录，相关工具会断开；使用 Token 配置的服务会保留。`,confirmLabel:'清除本机登录',action:()=>this.run('github.auth.forget',{revision:s.revision}),done:'本机 GitHub 登录已清除',tone:'danger'});
  });
  this.apply=button('保存登录到此服务',()=>{const s=this.status;if(s)void this.execute(()=>this.commit(s)).catch(()=>{});});
  this.waiting.append(this.code,this.deadline,this.open,this.cancel);
  const actions=element('div','','mcp-actions');actions.append(this.begin,this.apply,this.forget);
  this.error.setAttribute('role','alert');this.error.dataset.tone='bad';this.error.hidden=true;this.state.setAttribute('role','status');
  this.node.append(element('h3','浏览器登录'),element('p','授权在 GitHub 页面确认，灵伴只接收授权结果。登录后保存到此服务，再启用并连接工具。只读开关控制灵伴可调用的工具。','block-hint'),this.settings,this.state,this.waiting,actions,this.error);
  this.node.hidden=true;
 }
 show(visible:boolean,parentLocked:boolean){
  this.parentLocked=parentLocked;this.node.hidden=!visible;
  if(this.active!==visible){this.active=visible;this.ticket++;if(this.timer)clearInterval(this.timer);this.timer=undefined;if(visible){void this.poll();this.timer=setInterval(()=>void this.poll(),1000);}}
  this.render();
 }
 close(){this.show(false,false);}
 private fail(text:string){this.error.textContent=text;this.error.hidden=false;}
 private reason(e:any){return e?.code==='TOKEN_DRAFT'?'请先保存或清空尚未保存的 Token，再使用浏览器登录。':e?.code==='CONFLICT'?'状态已变化，请刷新后重试；输入内容已保留。':e?.code==='BUSY'?'请等待当前登录或刷新完成。':'操作未完成，请检查网络和登录状态后重试。';}
 private async poll(){
  if(!this.active||this.busy||this.polling)return;const ticket=this.ticket;this.polling=true;
  try{const value=await this.bridge.request('github.auth.status',undefined);if(ticket!==this.ticket||!this.active)return;this.update(value);if(!this.edited)this.client.value=value.clientId;this.render();}
  catch(e){if(ticket===this.ticket&&this.active)this.fail(this.reason(e));}finally{this.polling=false;}
 }
 private async execute(work:()=>Promise<MobileGithubAuth>){
  if(this.busy||this.parentLocked)throw Error('BUSY');this.busy=true;this.ticket++;this.error.hidden=true;this.busyChanged(true);this.render();
  try{const value=await work();this.update(value);if(!this.edited)this.client.value=value.clientId;return value;}
  catch(e){this.fail(this.reason(e));throw e;}
  finally{this.busy=false;this.busyChanged(false);this.render();}
 }
 private run<K extends keyof MobileGithubCommands>(method:K,p:MobileGithubCommands[K]['params']){return this.execute(()=>this.bridge.request(method,p));}
 private update(value:MobileGithubAuth){const old=this.status;this.status=value;if(this.edited&&this.client.value.trim()===value.clientId)this.edited=false;if(this.active&&old&&(old.revision!==value.revision||old.applied!==value.applied||old.targetRevision!==value.targetRevision))this.changed();}
 private render(){
  const s=this.status,locked=this.busy||this.parentLocked||this.status?.phase==='saving',authorizing=s?.phase==='authorizing',refreshing=s?.phase==='refreshing';
  this.state.textContent=s?`${s.user?'账号：'+s.user.login+'。':''}${s.detail}${s.applied?' 当前服务已使用此登录。':''}`:'正在读取 GitHub 登录状态…';
  if(s&&!s.clientId)this.settings.open=true;
  this.client.disabled=locked||!!authorizing||!!refreshing;this.save.disabled=locked||!s||!!authorizing||!!refreshing||this.client.value.trim()===s.clientId&&!s.configurationError;
  this.begin.disabled=locked||!s?.clientId||!!authorizing||!!refreshing||this.edited;this.begin.textContent=s?.connected?'重新获取 GitHub 验证码':'获取 GitHub 验证码';
  this.waiting.hidden=!authorizing;this.code.textContent=s?.authorization?.userCode??'正在获取验证码…';
  this.deadline.textContent=s?.authorization?`请在验证码过期前完成确认（剩余约 ${Math.max(0,Math.ceil((s.authorization.expiresAt-Date.now())/1000))} 秒）。`:'正在准备 GitHub 授权页面。';
  this.open.disabled=locked||!s?.authorization||s.authorization.expiresAt<=Date.now();this.cancel.disabled=locked||!authorizing;
  this.apply.hidden=!s?.connected||!!authorizing;this.apply.disabled=locked||!s?.connected||!!refreshing;
  this.forget.hidden=!s?.user;this.forget.disabled=locked||!!authorizing||!!refreshing;
 }
}
