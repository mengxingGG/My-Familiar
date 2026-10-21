import {createServer,type ServerResponse} from 'node:http';
import {WebSocketServer,WebSocket} from 'ws';
import assert from 'node:assert/strict';

// 飞书官方 protobuf Frame 的最小协议夹具；只绑定回环，不接收真实凭据。
const varint=(n:number)=>{const bytes=[];do{const b=n&127;n=Math.floor(n/128);bytes.push(b|(n?128:0));}while(n);return Buffer.from(bytes);};
const field=(n:number,b:Buffer)=>Buffer.concat([varint(n*8+2),varint(b.length),b]);
const header=(key:string,value:string)=>field(5,Buffer.concat([field(1,Buffer.from(key)),field(2,Buffer.from(value))]));
function frame(event:unknown,id:string){return Buffer.concat([Buffer.from([8,1,16,1,24,1,32,1]),...Object.entries({type:'event',message_id:id,sum:'1',seq:'0'}).map(([k,v])=>header(k,v)),field(8,Buffer.from(JSON.stringify(event)))]);}
function payload(bytes:Buffer){let i=0;const number=()=>{let n=0,shift=0,b;do{b=bytes[i++];n+=(b&127)*2**shift;shift+=7;}while(b&128);return n;};while(i<bytes.length){const tag=number();if((tag&7)===0)number();else if((tag&7)===2){const size=number(),part=bytes.subarray(i,i+size);i+=size;if(tag>>3===8)return JSON.parse(part.toString());}else throw Error('Unexpected protobuf field');}}
export const incoming=(id:string,text:string,sender='ou_fixture')=>({sender:{sender_type:'user',sender_id:{open_id:sender}},message:{message_id:id,chat_id:'oc_fixture',chat_type:'p2p',message_type:'text',content:JSON.stringify({text})}});
export async function feishuFixture(){
 const state={pulls:0,acks:0,model:[] as any[],replies:[] as {id:string,text:string,uuid:string}[],errors:[] as string[],hold:false,discoveryCode:0};
 let port=0,sequence=0;const sockets:WebSocket[]=[],held:ServerResponse[]=[];
 const discovered=(res:ServerResponse)=>res.end(JSON.stringify({code:state.discoveryCode,msg:'fixture discovery',data:{URL:`ws://127.0.0.1:${port}/ws?device_id=fixture&service_id=1`,ClientConfig:{PingInterval:60,ReconnectCount:2,ReconnectInterval:1,ReconnectNonce:0}}}));
 const server=createServer(async(req,res)=>{try{
  let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):{};
  res.setHeader('content-type','application/json');
  if(req.url==='/callback/ws/endpoint'){state.pulls++;assert(/^cli_[a-f0-9]{16}$/.test(body.AppID));assert.equal(body.AppSecret,'fixture-secret');if(state.hold){held.push(res);return;}discovered(res);}
  else if(req.url==='/open-apis/auth/v3/tenant_access_token/internal'){assert.equal(body.app_secret,'fixture-secret');res.end(JSON.stringify({code:0,tenant_access_token:'fixture-bot-token',expire:7200}));}
  else if(req.url?.match(/^\/open-apis\/im\/v1\/messages\/om_[\w-]+\/reply$/)){
   assert.equal(req.headers.authorization,'Bearer fixture-bot-token');assert.equal(body.msg_type,'text');state.replies.push({id:req.url.split('/').at(-2)!,text:JSON.parse(body.content).text,uuid:body.uuid});res.end(JSON.stringify({code:0,data:{message_id:'om_reply_'+state.replies.length}}));
  }else if(req.url==='/v1/models')res.end(JSON.stringify({data:[{id:'fixture-model',context_length:32768}]}));
  else if(req.url==='/v1/chat/completions'){
   state.model.push(body);const user=body.messages.filter((m:any)=>m.role==='user').at(-1),last=body.messages.at(-1);
   const choice=user.content==='操作'&&last.role!=='tool'?{delta:{tool_calls:[{index:0,id:'fixture-call-'+(++sequence),type:'function',function:{name:'fixture_write',arguments:'{}'}}]},finish_reason:'tool_calls'}:{delta:{content:'fixture-answer:'+user.content},finish_reason:'stop'};
   res.setHeader('content-type','text/event-stream');res.end(`data: ${JSON.stringify({choices:[choice]})}\n\ndata: [DONE]\n\n`);
  }else{state.errors.push('Unexpected path '+req.url);res.writeHead(404);res.end();}
 }catch(error){state.errors.push(String(error));res.writeHead(500);res.end();}});
 const ws=new WebSocketServer({server,path:'/ws'});ws.on('connection',socket=>{sockets.push(socket);socket.on('message',data=>{try{if(payload(Buffer.from(data as Buffer))?.code===200)state.acks++;}catch(error){state.errors.push(String(error));}});});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));port=(server.address() as {port:number}).port;
 return{state,url:`http://127.0.0.1:${port}`,release(){for(const res of held.splice(0))discovered(res);},send(event:ReturnType<typeof incoming>){const socket=sockets.findLast(s=>s.readyState===WebSocket.OPEN);assert(socket);const id='event-'+(++sequence);socket.send(frame({schema:'2.0',header:{event_id:id,event_type:'im.message.receive_v1',app_id:'cli_0123456789abcdef',create_time:String(Date.now())},event},id));},clients(){return sockets.filter(s=>s.readyState===WebSocket.OPEN).length;},async close(){for(const s of sockets)s.terminate();await new Promise<void>(r=>ws.close(()=>r()));server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}};
}
