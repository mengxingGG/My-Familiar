import net from 'node:net';
import {readFile} from 'node:fs/promises';
export async function probeSession(){return JSON.parse(await readFile('.artifacts/android-1.0/probe-session.json','utf8'));}
export async function probeCall(method,params,extra={}){
 const session=await probeSession();return new Promise((resolve,reject)=>{let text='';const socket=net.createConnection({host:'127.0.0.1',port:session.forwardPort},()=>socket.write(JSON.stringify({token:session.token,method,params,...extra})+'\n'));
 socket.setTimeout(65000,()=>{socket.destroy();reject(Error('RELEASE_PROBE_TIMEOUT'));});socket.on('error',()=>reject(Error('RELEASE_PROBE_DISCONNECTED')));socket.on('data',chunk=>{text+=chunk;if(text.length>8*1024*1024){socket.destroy();reject(Error('RELEASE_PROBE_LIMIT'));return;}const end=text.indexOf('\n');if(end>=0){socket.end();try{const r=JSON.parse(text.slice(0,end));if(!r.ok)reject(Error(method+': '+r.error?.code));else resolve(r.result);}catch(error){reject(error);}}});
 });
}
