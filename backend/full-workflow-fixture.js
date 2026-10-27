const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {spawn}=require('node:child_process');
const ganache=require('ganache');
const solc=require('solc');
const {ethers}=require('ethers');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function listen(server){return new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve(server.address().port))})}
function compile(){const file=path.resolve(__dirname,'../contracts/ResumeRegistry.sol');const input={language:'Solidity',sources:{'ResumeRegistry.sol':{content:fs.readFileSync(file,'utf8')}},settings:{outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}}};const output=JSON.parse(solc.compile(JSON.stringify(input)));const errors=(output.errors||[]).filter(error=>error.severity==='error');if(errors.length)throw Error(errors.map(error=>error.formattedMessage).join('\n'));return output.contracts['ResumeRegistry.sol'].ResumeRegistry}
async function main(){
  const dataDirectory=fs.mkdtempSync(path.join(os.tmpdir(),'credixa-full-ui-'));
  const evm=ganache.provider({logging:{quiet:true},wallet:{totalAccounts:3}});
  const rpcServer=http.createServer((request,response)=>{let body='';request.on('data',chunk=>body+=chunk);request.on('end',async()=>{try{const input=JSON.parse(body);const batch=Array.isArray(input)?input:[input];const results=await Promise.all(batch.map(async call=>{try{return{jsonrpc:'2.0',id:call.id,result:await evm.request({method:call.method,params:call.params||[]})}}catch(error){return{jsonrpc:'2.0',id:call.id,error:{code:-32000,message:error.message}}}}));response.writeHead(200,{'content-type':'application/json','access-control-allow-origin':'*','access-control-allow-headers':'content-type','access-control-allow-methods':'POST, OPTIONS'});response.end(JSON.stringify(Array.isArray(input)?results:results[0]))}catch(error){response.writeHead(400);response.end(error.message)}})});
  rpcServer.on('request',(request,response)=>{if(request.method==='OPTIONS'){response.writeHead(204,{'access-control-allow-origin':'*','access-control-allow-headers':'content-type','access-control-allow-methods':'POST, OPTIONS'});response.end()}});
  let app;
  const llm=http.createServer((request,response)=>{let body='';request.on('data',chunk=>body+=chunk);request.on('end',()=>{try{const prompt=JSON.parse(body).messages?.[0]?.content||'';let payload;if(prompt.startsWith('You are editing a resume using only its supplied content.')){const resume=prompt.split('Resume text:\n').pop();const source='Built accessible interfaces using React.';payload={suggestions:resume.includes(source)?[{title:'Tighten an experience bullet',reason:'Uses the same resume facts with more direct phrasing.',source_text:source,suggested_text:'Built accessible interfaces with React.'}]:[]};}else{const match=prompt.match(/Use these skills only: (\[[^\]]+\])\./);if(!match)throw Error('Unexpected mock LLM request');const skills=JSON.parse(match[1]);payload={questions:skills.flatMap(skill=>Array.from({length:5},(_,index)=>({skill,question:`${skill}: applied knowledge question ${index+1}?`,options:['Incorrect choice A','Incorrect choice B','Correct choice','Incorrect choice D'],correctOption:2,explanation:`The correct answer demonstrates applied ${skill} knowledge.`})))};}response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({choices:[{message:{content:JSON.stringify(payload)}}]}))}catch(error){response.writeHead(400,{'content-type':'application/json'});response.end(JSON.stringify({error:{message:error.message}}))}})});
  try{
    const rpcPort=await listen(rpcServer);const llmPort=await listen(llm);const rpcUrl=`http://127.0.0.1:${rpcPort}`;
    const artifact=compile();const provider=new ethers.BrowserProvider(evm);const signer=await provider.getSigner(0);const factory=new ethers.ContractFactory(artifact.abi,artifact.evm.bytecode.object,signer);const registry=await factory.deploy();await registry.waitForDeployment();const address=await registry.getAddress();
    const port=3005;
    app=spawn(process.execPath,['backend/server.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,PORT:String(port),APP_SECRET:'full-ui-test-secret-only',CREDIXA_DATA_DIR:dataDirectory,OPENAI_API_BASE_URL:`http://127.0.0.1:${llmPort}/v1/chat/completions`,EVM_RPC_URL:rpcUrl,RESUME_REGISTRY_ADDRESS:address,PUBLIC_BASE_URL:`http://localhost:${port}`},stdio:['ignore','pipe','pipe']});
    let output='';app.stdout.on('data',chunk=>output+=chunk.toString());app.stderr.on('data',chunk=>output+=chunk.toString());
    for(let i=0;i<80;i++){if(app.exitCode!==null)throw Error(output);try{const response=await fetch(`http://localhost:${port}/api/auth/me`);if(response.status===401)break}catch{}await wait(100)}
    const accounts=await evm.request({method:'eth_accounts',params:[]});
    console.log(JSON.stringify({ready:true,baseUrl:`http://localhost:${port}`,rpcUrl,contractAddress:address,account:accounts[0],tempDataDirectory:dataDirectory}));
    const stop=async()=>{if(app&&app.exitCode===null)app.kill();await new Promise(resolve=>llm.close(resolve));await new Promise(resolve=>rpcServer.close(resolve));if(evm.disconnect)await evm.disconnect();fs.rmSync(dataDirectory,{recursive:true,force:true});process.exit(0)};
    process.on('SIGINT',stop);process.on('SIGTERM',stop);
  }catch(error){if(app&&app.exitCode===null)app.kill();await new Promise(resolve=>llm.close(resolve));await new Promise(resolve=>rpcServer.close(resolve));if(evm.disconnect)await evm.disconnect();fs.rmSync(dataDirectory,{recursive:true,force:true});throw error}
}
main().catch(error=>{console.error(error);process.exit(1)});
