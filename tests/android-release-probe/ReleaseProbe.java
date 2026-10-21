package app.familiar.releaseprobe;

import android.app.*;
import android.content.*;
import android.os.Bundle;
import android.graphics.Rect;
import android.security.keystore.*;
import android.view.*;
import android.view.accessibility.*;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.webkit.WebView;
import org.json.*;
import java.net.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.util.*;
import javax.crypto.Cipher;

/** 只在同签名的独立测试 APK 中使用，不进入正式包，不开启 WebView 调试。 */
public final class ReleaseProbe extends Instrumentation {
  private String token, alias;
  private Activity current;
  private boolean stopping;
  private byte[] originalRecovery;private boolean recoveryCaptured;private final Set<String> transfers=new HashSet<>();
  private final Set<String> owned=new HashSet<>();
  private File ownershipFile(){return new File(getTargetContext().getFilesDir(),"familiar-acceptance-owned.json");}
  private void saveOwned() throws Exception {if(owned.isEmpty())ownershipFile().delete();else java.nio.file.Files.write(ownershipFile().toPath(),new JSONArray(owned).toString().getBytes(StandardCharsets.UTF_8));}
  private static final Set<String> allowed=new HashSet<>(Arrays.asList("snapshot.get","conversation.create","conversation.select","conversation.delete","reply.cancel","runtime.set","pet.settings.save","pet.docking.save","pet.chat.state","task.respond","message.send","provider.save","policy.get","policy.set","policy.resetSession","backup.export","backup.inspect","backup.recovery","backup.apply","backup.cancel","library.memory.list","library.memory.read","library.memory.write"));
  @Override public void onCreate(Bundle args){token=args.getString("token","");if(!token.matches("[a-zA-Z0-9_-]{32,100}")){finish(1,new Bundle());return;}start();}
  private JSONObject call(String method,JSONObject params) throws Exception {
    Class<?> c=getTargetContext().getClassLoader().loadClass("app.familiar.platform.RuntimeClient");
    JSONObject request=new JSONObject().put("protocolVersion",1).put("id","release-probe-"+UUID.randomUUID()).put("method",method);
    if(params!=null)request.put("params",params);
    return (JSONObject)c.getMethod("request",Context.class,JSONObject.class).invoke(c.getField("INSTANCE").get(null),getTargetContext(),request);
  }
  private WebView web(View v){if(v instanceof WebView)return (WebView)v;if(v instanceof ViewGroup){ViewGroup g=(ViewGroup)v;for(int i=0;i<g.getChildCount();i++){WebView found=web(g.getChildAt(i));if(found!=null)return found;}}return null;}
  private void nodes(AccessibilityNodeInfo n,JSONArray result,int depth){
    if(n==null||depth>70||result.length()>500)return;
    if(n.isVisibleToUser()&&!n.isPassword()){
      String desc=n.getContentDescription()==null?"":n.getContentDescription().toString();
      String text=n.isEditable()||n.getText()==null?"":n.getText().toString();
      if(!desc.isEmpty()||!text.isEmpty()||n.isClickable()||n.getViewIdResourceName()!=null){Rect r=new Rect();n.getBoundsInScreen(r);try{result.put(new JSONObject().put("text",text).put("description",desc).put("packageName",n.getPackageName()).put("resourceId",n.getViewIdResourceName()).put("clickable",n.isClickable()).put("enabled",n.isEnabled()).put("checked",n.isChecked()).put("x",r.centerX()).put("y",r.centerY()).put("left",r.left).put("top",r.top).put("right",r.right).put("bottom",r.bottom));}catch(JSONException ignored){}}
    }
    for(int i=0;i<n.getChildCount();i++)nodes(n.getChild(i),result,depth+1);
  }
  private JSONObject evaluate(String script) throws Exception {
    java.util.concurrent.CountDownLatch done=new java.util.concurrent.CountDownLatch(1);String[] value=new String[1];
    runOnMainSync(()->{if(current==null)throw new IllegalStateException();WebView v=web(current.getWindow().getDecorView());if(v==null)throw new IllegalStateException();v.evaluateJavascript(script,r->{value[0]=r;done.countDown();});});
    if(!done.await(8,java.util.concurrent.TimeUnit.SECONDS))throw new IllegalStateException();
    return new JSONObject().put("ok",true).put("result",value[0]==null||value[0].equals("null")?JSONObject.NULL:new org.json.JSONTokener(value[0]).nextValue());
  }
  @Override public void onStart(){
    Bundle done=new Bundle();
    try{
      if(ownershipFile().isFile()){JSONArray ids=new JSONArray(new String(java.nio.file.Files.readAllBytes(ownershipFile().toPath()),StandardCharsets.UTF_8));for(int i=0;i<ids.length();i++){String id=ids.getString(i);if(id.matches("[a-f0-9-]{36}"))owned.add(id);}}
      ((Application)getTargetContext().getApplicationContext()).registerActivityLifecycleCallbacks(new Application.ActivityLifecycleCallbacks(){
        public void onActivityResumed(Activity a){current=a;}
        public void onActivityCreated(Activity a,Bundle b){} public void onActivityStarted(Activity a){} public void onActivityPaused(Activity a){} public void onActivityStopped(Activity a){} public void onActivitySaveInstanceState(Activity a,Bundle b){} public void onActivityDestroyed(Activity a){if(current==a)current=null;}
      });
      alias="familiar.acceptance.transfer."+UUID.randomUUID();KeyPairGenerator gen=KeyPairGenerator.getInstance("RSA","AndroidKeyStore");
      gen.initialize(new KeyGenParameterSpec.Builder(alias,KeyProperties.PURPOSE_DECRYPT).setKeySize(2048).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_RSA_OAEP).setDigests(KeyProperties.DIGEST_SHA1).build());KeyPair pair=gen.generateKeyPair();
      try(ServerSocket server=new ServerSocket(0,5,InetAddress.getByName("127.0.0.1"))){
        server.setSoTimeout(1000);Bundle ready=new Bundle();ready.putString("port",Integer.toString(server.getLocalPort()));ready.putString("publicKey",Base64.getEncoder().encodeToString(pair.getPublic().getEncoded()));sendStatus(0,ready);
        long deadline=System.currentTimeMillis()+30*60*1000;
        while(!stopping&&System.currentTimeMillis()<deadline){
          Socket socket;try{socket=server.accept();}catch(SocketTimeoutException wait){continue;}
          try(Socket client=socket){client.setSoTimeout(10000);String line=new BufferedReader(new InputStreamReader(client.getInputStream(),StandardCharsets.UTF_8)).readLine();if(line==null||line.length()>1024*1024)continue;JSONObject p=new JSONObject(line),answer;
            try{
              if(!token.equals(p.optString("token")))throw new SecurityException();String method=p.getString("method");JSONObject params=p.optJSONObject("params");
              if(method.equals("finish")){stopping=true;answer=new JSONObject().put("ok",true);}
              else if(method.equals("backup.capture")){File f=new File(getTargetContext().getFilesDir(),"transfer/previous.familiar");if(recoveryCaptured)throw new IllegalStateException();originalRecovery=f.exists()?java.nio.file.Files.readAllBytes(f.toPath()):null;recoveryCaptured=true;answer=new JSONObject().put("ok",true).put("result",new JSONObject().put("exists",originalRecovery!=null));}
              else if(method.equals("backup.cleanup")){if(!recoveryCaptured)throw new IllegalStateException();File f=new File(getTargetContext().getFilesDir(),"transfer/previous.familiar");if(originalRecovery==null)f.delete();else java.nio.file.Files.write(f.toPath(),originalRecovery);for(String id:transfers)new File(getTargetContext().getFilesDir(),"transfer/"+id+".familiar").delete();answer=new JSONObject().put("ok",true);}
              else if(method.equals("ui.request")){
                String target=params.getString("method");if(!Arrays.asList("backup.export","backup.choose").contains(target))throw new SecurityException();
                JSONObject request=new JSONObject().put("protocolVersion",1).put("id","probe-ui-"+UUID.randomUUID()).put("method",target);if(params.has("params"))request.put("params",params.get("params"));
                answer=evaluate("(()=>{window.__familiarProbeResult=null;window.__TAURI_INTERNALS__.invoke('plugin:familiar-android|invoke',{payload:"+request.toString()+"}).then(r=>window.__familiarProbeResult=r).catch(()=>window.__familiarProbeResult={ok:false,error:{code:'UNAVAILABLE'}});return {started:true}})()");
              }else if(method.equals("ui.result")){answer=evaluate("window.__familiarProbeResult ?? null");}
              else if(method.equals("ui.dom")){answer=evaluate("Array.from(document.querySelectorAll('button,input,select,label')).filter(e=>e.getBoundingClientRect().width>0 && e.getBoundingClientRect().height>0).map(e=>{const r=e.getBoundingClientRect();return {tag:e.tagName,type:e.type||'',label:e.getAttribute('aria-label')||e.labels?.[0]?.textContent||e.textContent||'',disabled:!!e.disabled,x:r.x,y:r.y,w:r.width,h:r.height}})");}
              else if(method.equals("controls")){
                UiAutomation ui=getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);AccessibilityServiceInfo info=ui.getServiceInfo();info.flags|=AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;info.eventTypes=AccessibilityEvent.TYPES_ALL_MASK;ui.setServiceInfo(info);if(android.os.Build.VERSION.SDK_INT>=33)ui.clearCache();JSONArray result=new JSONArray();for(AccessibilityWindowInfo w:ui.getWindows()){AccessibilityNodeInfo root=w.getRoot();if(root!=null)root.refresh();nodes(root,result,0);}answer=new JSONObject().put("ok",true).put("result",result);
              }else if(method.equals("ui.type")||method.equals("ui.ime")){
                String text=method.equals("ui.type")?params.getString("text"):"";if(text.length()>8000)throw new SecurityException();
                UiAutomation ui=getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);if(android.os.Build.VERSION.SDK_INT>=33)ui.clearCache();
                boolean sent=false;for(AccessibilityWindowInfo w:ui.getWindows()){AccessibilityNodeInfo root=w.getRoot();if(root==null)continue;java.util.ArrayDeque<AccessibilityNodeInfo> queue=new java.util.ArrayDeque<>();queue.add(root);while(!queue.isEmpty()){AccessibilityNodeInfo n=queue.remove();if("app.familiar.mobile".equals(String.valueOf(n.getPackageName()))&&"气泡聊天输入".equals(String.valueOf(n.getContentDescription()))&&n.isEditable()&&!n.isPassword()){Bundle args=new Bundle();args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,text);sent=method.equals("ui.ime")?n.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.getId()):n.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT,args);}for(int i=0;i<n.getChildCount();i++){AccessibilityNodeInfo child=n.getChild(i);if(child!=null)queue.add(child);}n.recycle();}w.recycle();}if(!sent)throw new IllegalStateException();answer=new JSONObject().put("ok",true);
              }else if(method.equals("capability.request")){
                final String id=params.getString("id");if(!Arrays.asList("calendar","overlay","accessibility").contains(id))throw new SecurityException();runOnMainSync(()->{if(current==null)throw new IllegalStateException();WebView v=web(current.getWindow().getDecorView());if(v==null)throw new IllegalStateException();v.evaluateJavascript("window.__TAURI_INTERNALS__.invoke('plugin:familiar-android|invoke',{payload:{protocolVersion:1,id:'release-permission',method:'capability.request',params:{id:"+JSONObject.quote(id)+"}}})",null);});answer=new JSONObject().put("ok",true);
              }else if(method.equals("provider.configure")){
                if(!"compatible".equals(params.getString("kind"))||!"https://api.deepseek.com".equals(params.getString("baseUrl"))||!"deepseek-flash".equals(params.getString("model")))throw new SecurityException();Cipher cipher=Cipher.getInstance("RSA/ECB/OAEPWithSHA-1AndMGF1Padding");cipher.init(Cipher.DECRYPT_MODE,pair.getPrivate());byte[] plain=cipher.doFinal(Base64.getDecoder().decode(p.getString("encryptedKey")));params.put("apiKey",new String(plain,StandardCharsets.UTF_8));Arrays.fill(plain,(byte)0);try{answer=call("provider.save",params);}finally{params.remove("apiKey");}
              }else if(method.equals("owned.trace")){
                String id=params.getString("id");if(!owned.contains(id))throw new SecurityException();JSONObject stored=new JSONObject(new String(java.nio.file.Files.readAllBytes(new File(getTargetContext().getFilesDir(),"data/conversation-session-"+id+".json").toPath()),StandardCharsets.UTF_8));JSONArray messages=stored.getJSONArray("messages"),results=new JSONArray();for(int i=0;i<messages.length();i++){JSONArray trace=messages.getJSONObject(i).optJSONArray("trace");if(trace==null)continue;for(int j=0;j<trace.length();j++){JSONObject t=trace.getJSONObject(j);if("tool".equals(t.optString("role")))results.put(new JSONObject().put("name",t.getString("toolName")).put("result",t.opt("content")));}}answer=new JSONObject().put("ok",true).put("result",results);
              }else{
                if(!allowed.contains(method)&&!Arrays.asList("updates.state","updates.check","updates.download","updates.cancel","updates.open").contains(method))throw new SecurityException();if(method.equals("message.send")&&!owned.contains(params.getString("conversationId")))throw new SecurityException();if(method.equals("conversation.delete")&&!owned.contains(params.getString("id")))throw new SecurityException();answer=call(method,params);if(method.equals("conversation.create")&&answer.optBoolean("ok")){owned.add(answer.getJSONObject("result").getString("id"));saveOwned();}if(method.equals("conversation.delete")&&answer.optBoolean("ok")){owned.remove(params.getString("id"));saveOwned();}
              }
              JSONObject returned=answer.optJSONObject("result");if(method.equals("ui.result")&&returned!=null)returned=returned.optJSONObject("result");if(returned!=null && returned.optString("token").matches("[a-f0-9-]{36}"))transfers.add(returned.getString("token"));
            }catch(Throwable error){answer=new JSONObject().put("ok",false).put("error",new JSONObject().put("code",error.getClass().getSimpleName()));}
            client.getOutputStream().write((answer.toString()+"\n").getBytes(StandardCharsets.UTF_8));client.getOutputStream().flush();
          }
        }
      }
      done.putString("result","finished");
    }catch(Throwable error){done.putString("error",error.getClass().getSimpleName());}
    finally{try{KeyStore store=KeyStore.getInstance("AndroidKeyStore");store.load(null);if(alias!=null)store.deleteEntry(alias);}catch(Exception ignored){}finish(0,done);}
  }
}
