import {createServer} from 'node:http';
/** 真 HTTP/JSON-RPC 夹具，只接收测试文字；记录鉴权是否正确，不记录密钥。 */
export async function httpMcpFixture(){
  const state={calls:[] as {name:string;text:string}[],requests:[] as {path:string;method:string;authenticated:boolean}[],slowStarted:0,catalogBytes:0};
  const server=createServer(async(req,res)=>{
    if(req.method!=='POST'){res.writeHead(405);res.end();return;}
    const url=new URL(req.url!,'http://127.0.0.1');
    if(url.pathname==='/redirect'){res.writeHead(302,{location:'/mcp'});res.end();return;}
    let raw='';for await(const chunk of req)raw+=chunk;const rpc=JSON.parse(raw);
    state.requests.push({path:url.pathname,method:rpc.method,authenticated:req.headers['x-fixture-key']==='isolated-mcp-key'||url.searchParams.get('credential')==='isolated-mcp-key'});
    if(rpc.id===undefined){res.writeHead(202);res.end();return;}
    let result:unknown={};
    if(rpc.method==='initialize')result={protocolVersion:rpc.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'isolated-http-mcp',version:'1'}};
    else if(rpc.method==='tools/list'){
      if(url.pathname==='/slow'){state.slowStarted++;await new Promise<void>(r=>{const timer=setTimeout(r,15000);res.on('close',()=>{clearTimeout(timer);r();});});if(res.destroyed)return;}
      const names=url.pathname==='/large'?['echo','picture',...Array.from({length:78},(_,i)=>'tool_'+String(i).padStart(3,'0'))]:url.pathname==='/duplicate'?['echo','echo']:['echo','picture'];
      const padding=url.pathname==='/large'?Object.fromEntries(Array.from({length:8},(_,i)=>['context_'+i,{type:'string',maxLength:300,description:'Optional contextual information for this particular operation; the caller may omit it when no additional context is required.'}])):{};
      result={tools:names.map(name=>({name,description:`HTTP fixture ${name}`,inputSchema:{type:'object',properties:{text:{type:'string',maxLength:200},...padding},required:['text'],additionalProperties:false},annotations:{readOnlyHint:true}}))};
      if(url.pathname==='/large')state.catalogBytes=Buffer.byteLength(JSON.stringify(result));
    }else if(rpc.method==='tools/call'){
      state.calls.push({name:rpc.params.name,text:rpc.params.arguments.text});
      result={content:rpc.params.name==='picture'?[{type:'image',mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII='}]:[{type:'text',text:'echo:'+rpc.params.arguments.text}]};
    }
    res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}));
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as {port:number}).port;
  return{state,port,url:`http://127.0.0.1:${port}`,async close(){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}};
}
