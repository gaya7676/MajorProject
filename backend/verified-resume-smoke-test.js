const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const ganache = require('ganache');
const solc = require('solc');
const { ethers } = require('ethers');

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function listen(server) { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); return server.address().port; }
async function close(server) { if (server?.listening) await new Promise(resolve => server.close(resolve)); }
function compileRegistry() {
  const source = fs.readFileSync(path.resolve(__dirname, '../contracts/ResumeRegistry.sol'), 'utf8');
  const input = { language: 'Solidity', sources: { 'ResumeRegistry.sol': { content: source } }, settings: { outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors || []).filter(error => error.severity === 'error');
  assert.equal(errors.length, 0, errors.map(error => error.formattedMessage).join('\n'));
  return output.contracts['ResumeRegistry.sol'].ResumeRegistry;
}
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function openProfile(ciphertext, secret) {
  const key = crypto.createHash('sha256').update(secret).digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ciphertext.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(ciphertext.tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertext.data, 'base64')), decipher.final()]).toString('utf8'));
}
function sealProfile(profile, secret) {
  const key = crypto.createHash('sha256').update(secret).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(profile), 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

async function main() {
  const temporaryData = fs.mkdtempSync(path.join(os.tmpdir(), 'credixa-verified-resume-'));
  const testSecret = 'verified-resume-test-only-secret';
  const registryArtifact = compileRegistry();
  const provider = ganache.provider({ logging: { quiet: true }, wallet: { totalAccounts: 3 } });
  const rpcServer = http.createServer((request, response) => {
    let body='';
    request.on('data',chunk=>{body+=chunk});
    request.on('end',async()=>{
      try{
        const requests=JSON.parse(body);const batch=Array.isArray(requests)?requests:[requests];
        const results=await Promise.all(batch.map(async rpc=>{
          try{return {jsonrpc:'2.0',id:rpc.id,result:await provider.request({method:rpc.method,params:rpc.params||[]})}}
          catch(error){return {jsonrpc:'2.0',id:rpc.id,error:{code:-32000,message:error.message}}}
        }));
        response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify(Array.isArray(requests)?results:results[0]));
      }catch(error){response.writeHead(400,{'content-type':'application/json'});response.end(JSON.stringify({error:error.message}));}
    });
  });
  let mockLlm;
  let app;
  let rpcHttp;
  let rpcPort;
  let llmPort;
  let appPort;
  try {
    const rpcUrl = `http://127.0.0.1:${await listen(rpcServer)}`;
    rpcPort = rpcServer.address().port;
    const rpcProvider = new ethers.BrowserProvider(provider);
    const signer = await rpcProvider.getSigner(0);
    const factory = new ethers.ContractFactory(registryArtifact.abi, registryArtifact.evm.bytecode.object, signer);
    const contract = await factory.deploy();
    await contract.waitForDeployment();
    const contractAddress = await contract.getAddress();

    mockLlm = http.createServer((request, response) => {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        const prompt = JSON.parse(body).messages?.[0]?.content || '';
        const requested = JSON.parse(prompt.match(/Use these skills only: (\[[^\]]+\])\./)[1]);
        const questions = requested.flatMap(skill => Array.from({ length: 5 }, (_, index) => ({ skill, question: `${skill} test question number ${index + 1}?`, options: ['wrong a','wrong b','correct','wrong d'], correctOption: 2, explanation: `Option C is correct for ${skill} in this test.` })));
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ questions }) } }] }));
      });
    });
    llmPort = await listen(mockLlm);
    appPort = 38000 + Math.floor(Math.random() * 10000);
    app = spawn(process.execPath, ['backend/server.js'], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, PORT: String(appPort), APP_SECRET: testSecret, CREDIXA_DATA_DIR: temporaryData, OPENAI_API_BASE_URL: `http://127.0.0.1:${llmPort}/v1/chat/completions`, EVM_RPC_URL: rpcUrl, RESUME_REGISTRY_ADDRESS: contractAddress, PUBLIC_BASE_URL: 'https://credixa.test' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    app.stdout.on('data', chunk => { output += chunk.toString(); });
    app.stderr.on('data', chunk => { output += chunk.toString(); });
    const base = `http://127.0.0.1:${appPort}`;
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (app.exitCode !== null) throw Error(`Credixa server stopped: ${output}`);
      try { if ((await fetch(`${base}/api/auth/me`)).status === 401) { ready = true; break; } } catch { /* wait for local listener */ }
      await wait(100);
    }
    assert.equal(ready, true, `Credixa server did not start: ${output}`);
    const registered = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `verified-${Date.now()}@example.test`, password: 'verified-smoke-password', name: 'Private Candidate' }) });
    assert.equal(registered.status, 201);
    const cookie = registered.headers.get('set-cookie').split(';')[0];
    const api = (route, body, method='POST') => fetch(`${base}${route}`, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const resumeText = 'Private Candidate\nprivate@example.test\nSkills\nJavaScript, Python\nExperience\nBuilt web applications.';
    const savedProfile = await api('/api/profile', { resumeText, analysis: { skills: ['JavaScript','Python'], extracted: { skills: ['JavaScript','Python'], qualifications: [], projects: [], experience: [] } }, preferences: {}, jobs: [] }, 'PUT');
    assert.equal(savedProfile.status, 200);
    const sessionResponse = await api('/api/assessments/start', { skills: ['JavaScript'], difficulty: 'intermediate', minutes: 10, thirdWarningAction: 'submit', provider: 'openai', apiKey: 'local-test-key', model: 'mock-model' });
    assert.equal(sessionResponse.status, 201);
    const session = await sessionResponse.json();
    const submit = await api('/api/assessments/submit', { assessmentId: session.assessmentId, answers: Object.fromEntries(session.questions.map(question => [question.id, 2])) });
    assert.equal(submit.status, 200);
    const assessmentReport = (await submit.json()).report;
    assert.equal(assessmentReport.perSkill[0].criteriaMet, true);

    const createdResponse = await api('/api/verifications', {});
    assert.equal(createdResponse.status, 201, await createdResponse.clone().text());
    const created = await createdResponse.json();
    assert.match(created.verificationId, /^[a-f0-9]{48}$/);
    assert.equal(created.publicUrl, `https://credixa.test/verify/${created.verificationId}`);
    assert.equal(created.skills.find(skill => skill.skill === 'JavaScript').status, 'verified');
    const record = (await (await api('/api/verifications', null, 'GET')).json()).records[0];
    assert.equal(record.record.skills.find(skill => skill.skill === 'JavaScript').status, 'verified');
    assert.equal(record.record.skills.find(skill => skill.skill === 'Python').status, 'not_assessed');

    const contractFromTest = new ethers.Contract(contractAddress, registryArtifact.abi, signer);
    const tx = await contractFromTest.registerResume(`0x${record.recordHash}`);
    const receipt = await tx.wait();
    const confirmation = await api(`/api/verifications/${created.verificationId}/confirm`, { transactionHash: receipt.hash });
    assert.equal(confirmation.status, 200, await confirmation.clone().text());
    const publicResponse = await fetch(`${base}/api/public-verifications/${created.verificationId}`);
    const publicRecord = await publicResponse.json();
    assert.equal(publicRecord.status, 'integrity_match');
    assert.equal(publicRecord.verifiedSkills[0].skill, 'JavaScript');
    const pageResponse = await fetch(`${base}/verify/${created.verificationId}`);
    assert.equal(pageResponse.status, 200);
    assert.match(await pageResponse.text(), /Record integrity check/);

    const userFile = path.join(temporaryData, 'users.json');
    const users = JSON.parse(fs.readFileSync(userFile, 'utf8'));
    const email = Object.keys(users)[0];
    const profile = openProfile(users[email].profile, testSecret);
    profile.verificationRecords[0].record.skills[0].score = 81;
    users[email].profile = sealProfile(profile, testSecret);
    fs.writeFileSync(userFile, JSON.stringify(users));
    const modifiedResponse = await fetch(`${base}/api/public-verifications/${created.verificationId}`);
    const modified = await modifiedResponse.json();
    assert.equal(modified.status, 'record_modified');

    const privateContact = await fetch(`${base}/api/public-verifications/${created.verificationId}`).then(response => response.text());
    assert.equal(privateContact.includes('private@example.test'), false);
    console.log('Verified Skills integration passed: assessment-derived record, ResumeRegistry deployment and transaction, public QR target route, live ledger/hash comparison, private data isolation, and modified-record rejection.');
  } finally {
    if (app && app.exitCode === null) app.kill();
    await close(mockLlm);
    await close(rpcServer);
    if (provider.disconnect) await provider.disconnect();
    fs.rmSync(temporaryData, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
