require('dotenv').config({
  path: require('node:path').join(__dirname, '.env')
});

console.log(
  "Gemini API key loaded:",
  Boolean(process.env.GEMINI_API_KEY)
);

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { ethers } = require('ethers');

const projectRoot = path.resolve(__dirname, '..');
const root = path.join(projectRoot, 'frontend');
const scrypt = promisify(crypto.scrypt);
const dataDir = path.resolve(process.env.CREDIXA_DATA_DIR || path.join(__dirname, 'data'));
fs.mkdirSync(dataDir, { recursive: true });
const usersFile = path.join(dataDir, 'users.json');
const secretFile = path.join(dataDir, '.app-secret');
let appSecret;
if (process.env.APP_SECRET) appSecret = crypto.createHash('sha256').update(process.env.APP_SECRET).digest();
else {
  if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32), { mode: 0o600, flag: 'wx' });
  appSecret = crypto.createHash('sha256').update(fs.readFileSync(secretFile)).digest();
}
const sessions = new Map();
const loginAttempts = new Map();
const pendingAssessments = new Map();
let remotiveCache = { at: 0, jobs: [] };
function plainText(html) { return String(html || '').replace(/<\/(p|div|li|h[1-6])>/gi, '\n').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/\s+/g, ' ').trim(); }
function validHttpUrl(value) { try { const url=new URL(String(value||'')); return ['http:','https:'].includes(url.protocol) ? url.href : ''; } catch { return ''; } }
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function verificationHash(record) { return crypto.createHash('sha256').update(canonicalJson(record),'utf8').digest('hex'); }
function verificationContract() {
  const rpcUrl=process.env.EVM_RPC_URL;
  const address=process.env.RESUME_REGISTRY_ADDRESS;
  if(!rpcUrl||!address||!ethers.isAddress(address))throw new Error('EVM verification is not configured. Set EVM_RPC_URL and RESUME_REGISTRY_ADDRESS.');
  const provider=new ethers.JsonRpcProvider(rpcUrl);
  const abi=['function records(bytes32) view returns (address owner,uint64 timestamp)','event ResumeRegistered(bytes32 indexed resumeHash,address indexed owner,uint64 timestamp)'];
  return {provider,address,contract:new ethers.Contract(address,abi,provider),interface:new ethers.Interface(abi)};
}
function looksLikeJobPosting(result) {
  const title=String(result.title||'').toLowerCase();
  const content=String(result.raw_content||result.content||'').toLowerCase();
  const url=String(result.url||'').toLowerCase();
  const roleTitle=/\b(engineer|developer|intern|analyst|designer|manager|scientist|specialist|consultant|technician|associate|coordinator|architect|accountant|researcher|recruiter|administrator|teacher|nurse|sales|marketing|product|security|support)\b/.test(title);
  const applicationEvidence=/\b(apply|application|responsibilities|qualifications|requirements|job description|employment type|full.?time|part.?time|internship|position)\b/.test(content)||/\/(jobs?|careers?)\//.test(url);
  return roleTitle&&applicationEvidence;
}
function jobIsExpired(job, now=Date.now()) {
  const expiry=job.expiration_date||job.expires_at||job.expiresAt||job.expiry_date;
  if(expiry&&Number.isFinite(Date.parse(expiry))&&Date.parse(expiry)<now)return true;
  const published=job.publication_date||job.published_at||job.date;
  return published&&Number.isFinite(Date.parse(published))&&now-Date.parse(published)>90*24*60*60*1000;
}
function jobFitsLocation(job, location) {
  const stated=String(job.candidate_required_location||job.location||'').toLowerCase();
  const wanted=String(location||'India').trim().toLowerCase();
  const indiaCities=['bengaluru','bangalore','mumbai','delhi','new delhi','hyderabad','chennai','pune','kolkata','ahmedabad','noida','gurugram','gurgaon','kochi','jaipur','indore','chandigarh','mysore','mysuru','mangalore','visakhapatnam','bhubaneswar','thiruvananthapuram','coimbatore','nagpur'];
  if(!wanted||wanted==='india')return /\bindia\b/.test(stated)||indiaCities.some(city=>stated.includes(city));
  if(indiaCities.includes(wanted))return stated.includes(wanted)||(/\bindia\b/.test(stated)&&!(/\b(usa|united states|uk|united kingdom|canada|australia|europe)\b/.test(stated)));
  return stated.includes(wanted)||/worldwide|anywhere|global/.test(stated)&&/remote|worldwide|global/.test(wanted);
}
async function getJobResults(query, location='India') {
  const now=Date.now();
  if (now-remotiveCache.at > (remotiveCache.error?60_000:6*60*60*1000)) {
    try {
      const response=await fetch('https://remotive.com/api/remote-jobs?limit=1000',{signal:AbortSignal.timeout(7000)});
      if(!response.ok)throw new Error(`Remote jobs feed returned ${response.status}`);
      const payload=await response.json(); if(!Array.isArray(payload.jobs))throw new Error('Remote jobs feed response was not recognized.');
      remotiveCache={at:now,jobs:payload.jobs,error:''};
    } catch (e) { remotiveCache={at:now,jobs:[],error:e.message}; console.warn('Remotive jobs feed unavailable:',e.message); }
  }
  const terms=String(query||'').toLowerCase().split(/[^a-z0-9+#.]+/).filter(w=>w.length>2);
  if(remotiveCache.jobs.length) {
    const now=Date.now();
    const locationEligible=remotiveCache.jobs.filter(job=>jobFitsLocation(job,location));
    const expiredCount=locationEligible.filter(job=>jobIsExpired(job,now)).length;
    const missingLinkCount=locationEligible.filter(job=>!jobIsExpired(job,now)&&!validHttpUrl(job.url)).length;
    const eligible=locationEligible.filter(job=>!jobIsExpired(job,now)&&validHttpUrl(job.url));
    const ranked=eligible.map(job=>{const hay=`${job.title} ${job.category} ${job.description}`.toLowerCase();const matched=terms.filter(term=>hay.includes(term));return {job,matched,rank:matched.length};}).sort((a,b)=>b.rank-a.rank).slice(0,18);
    return {source:'remotive',results:ranked.map(({job})=>({title:String(job.title||'').slice(0,180),url:validHttpUrl(job.url),content:plainText(job.description).slice(0,5000),published_date:job.publication_date||'',company:String(job.company_name||'').slice(0,160),location:String(job.candidate_required_location||'').slice(0,180),category:String(job.category||'').slice(0,100),source:'Remotive'})),notice:`Remotive public remote-jobs feed. Excluded ${expiredCount} expired or over-90-day listing(s) and ${missingLinkCount} listing(s) without a valid application link. Confirm availability on the linked employer page.`};
  }
  return {source:'remotive',results:[],unavailable:!!remotiveCache.error,notice:remotiveCache.error?`Live job feed unavailable (${remotiveCache.error}). Configure a Tavily Search API key in Settings or retry when the public feed is reachable.`:'No current listings with valid application links matched this search. Try another location or search terms.'};
}
function loadUsers() { try { return JSON.parse(fs.readFileSync(usersFile, 'utf8')); } catch { return {}; } }
function saveUsers(users) { const tmp = usersFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(users), { mode: 0o600 }); fs.renameSync(tmp, usersFile); }
function seal(value) {
  const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', appSecret, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') };
}
function unseal(value) {
  if (!value) return {};
  const decipher = crypto.createDecipheriv('aes-256-gcm', appSecret, Buffer.from(value.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]).toString('utf8'));
}
function sessionUser(req) {
  const cookie = req.headers.cookie || ''; const id = cookie.match(/(?:^|;\s*)credixa_session=([a-f0-9]+)/)?.[1];
  const session = id && sessions.get(id); if (!session || session.expires < Date.now()) { if (id) sessions.delete(id); return null; }
  return { id, email: session.email };
}
function send(res, status, body, headers = {}) { res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', ...headers }); res.end(JSON.stringify(body)); }
function cookieHeader(id, maxAge = 60 * 60 * 24 * 7) { return `credixa_session=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`; }
function readBody(req, max = 1_000_000) {
  return new Promise((resolve, reject) => { let body=''; req.on('data', chunk => { body += chunk; if (body.length > max) { reject(new Error('Request is too large.')); req.destroy(); } }); req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('Invalid request.')); } }); req.on('error', reject); });
}

// Dynamic question distribution algorithm
function distributeQuestions(skills, totalQuestions) {
  if (!skills.length) return {};
  
  // Calculate base questions per skill
  const basePerSkill = Math.floor(totalQuestions / skills.length);
  const remainder = totalQuestions % skills.length;
  
  const distribution = {};
  skills.forEach((skill, index) => {
    // Distribute remainder questions to first N skills
    distribution[skill] = basePerSkill + (index < remainder ? 1 : 0);
  });
  
  return distribution;
}

async function requestAssessmentQuestions({ provider, apiKey, model, skills, difficulty, questionDistribution }) {
  // Try environment variables first, then fall back to provided apiKey
  let effectiveApiKey = apiKey;
  
  if (!effectiveApiKey) {
    // Check environment variables based on provider
    if (provider === 'openai') {
      effectiveApiKey = process.env.OPENAI_API_KEY;
    } else if (provider === 'anthropic') {
      effectiveApiKey = process.env.ANTHROPIC_API_KEY;
    } else if (provider === 'gemini') {
      effectiveApiKey = process.env.GEMINI_API_KEY;
    }
  }
  
  if (!effectiveApiKey) {
    throw new Error('No API key configured. Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or GEMINI_API_KEY environment variable, or provide a key in Settings.');
  }
  
  if (!['openai','anthropic','gemini'].includes(provider)) {
    throw new Error('Choose a supported LLM provider (openai, anthropic, or gemini).');
  }
  
  // Build skill-specific question count instructions
  const distributionText = Object.entries(questionDistribution)
    .map(([skill, count]) => `${skill}: ${count} questions`)
    .join(', ');
  
  const totalExpected = Object.values(questionDistribution).reduce((sum, count) => sum + count, 0);
  
  const prompt=`Generate exactly ${totalExpected} original multiple-choice technical assessment questions distributed as follows: ${distributionText}. All questions should be at difficulty level: ${difficulty}. Questions must assess applied knowledge, not personal facts. Return only JSON: {"questions":[{"skill":"exact requested skill","question":"...","options":["...","...","...","..."],"correctOption":0,"explanation":"brief objective explanation"}]}. Each correctOption is a zero-based integer. Exactly one option must be correct, all four options must be distinct, no question may depend on facts not stated, and do not include trick or ambiguous items. Generate questions in the exact order and count specified for each skill.`;
  
  let url,payload,headers;
  if(provider==='anthropic'){
    url='https://api.anthropic.com/v1/messages';
    headers={'x-api-key':effectiveApiKey,'anthropic-version':'2023-06-01','content-type':'application/json'};
    payload={model:model||'claude-3-5-sonnet-latest',max_tokens:8000,messages:[{role:'user',content:prompt}]};
  }else if(provider==='gemini'){
    url=`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model||'gemini-3.8-flash')}:generateContent?key=${encodeURIComponent(effectiveApiKey)}`;
    headers={'content-type':'application/json'};
    payload={contents:[{role:'user',parts:[{text:prompt}]}],generationConfig:{maxOutputTokens:16000,responseMimeType:'application/json'}};
  }else{
    url=process.env.OPENAI_API_BASE_URL||'https://api.openai.com/v1/chat/completions';
    headers={'Authorization':`Bearer ${effectiveApiKey}`,'content-type':'application/json'};
    payload={model:model||'gpt-4o-mini',messages:[{role:'user',content:prompt}],temperature:0.2,response_format:{type:'json_object'}};
  }
 const timeoutMs = Number(process.env.LLM_TIMEOUT_MS || 300000);

console.log(
  `[Assessment] Provider: ${provider}, Model: ${model || "default"}, Questions: ${totalExpected}, Timeout: ${timeoutMs}ms`
);

const startedAt = Date.now();

let response;

try {
  response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
} catch (error) {
  console.error(
    `[Assessment] Request failed after ${Date.now() - startedAt}ms:`,
    error.name,
    error.message
  );

  if (error.name === "TimeoutError" || error.name === "AbortError") {
    throw new Error(
      `Assessment generation timed out after ${timeoutMs / 1000} seconds. Try fewer questions or retry.`
    );
  }

  throw error;
}

console.log(`[Assessment] HTTP response received in ${Date.now() - startedAt}ms`);
  const data=await response.json();
  if(!response.ok)throw new Error(data.error?.message||data.message||`LLM provider returned ${response.status}`);
  const content=provider==='anthropic'?data.content?.find(item=>item.type==='text')?.text:provider==='gemini'?data.candidates?.[0]?.content?.parts?.[0]?.text:data.choices?.[0]?.message?.content;
  if(!content)throw new Error('The model returned an empty assessment response.');

const cleanedContent = content
  .trim()
  .replace(/^```(?:json)?\s*/i, "")
  .replace(/\s*```$/, "");

let parsed;

try {
  parsed = JSON.parse(cleanedContent);
} catch (error) {
  console.error("Assessment JSON parsing failed:", error.message);
  console.error("Response length:", cleanedContent.length);
  console.error("Response ending:", cleanedContent.slice(-500));
  console.error("Gemini finish reason:", data.candidates?.[0]?.finishReason);

  throw new Error(
    "Gemini returned invalid or incomplete assessment JSON. Check the backend terminal for diagnostics."
  );
}

  if(!Array.isArray(parsed.questions))throw new Error('The model response did not contain a questions list.');
  
  // Validate total question count
  if(parsed.questions.length!==totalExpected)throw new Error(`The model returned ${parsed.questions.length} questions but ${totalExpected} were expected. Retry generation.`);
  
  // Validate per-skill distribution
  const skillCounts = {};
  parsed.questions.forEach(q => {
    skillCounts[q.skill] = (skillCounts[q.skill] || 0) + 1;
  });
  
  for (const [skill, expectedCount] of Object.entries(questionDistribution)) {
    const actualCount = skillCounts[skill] || 0;
    if (actualCount !== expectedCount) {
      throw new Error(`The model returned ${actualCount} questions for ${skill} but ${expectedCount} were expected. Retry generation.`);
    }
  }
  
  const questions=parsed.questions.map((question,index)=>{
    if(!question||!questionDistribution[question.skill]||typeof question.question!=='string'||question.question.trim().length<15||question.question.length>1200)throw new Error('The model returned an invalid question. Retry generation.');
    if(!Array.isArray(question.options)||question.options.length!==4||question.options.some(option=>typeof option!=='string'||!option.trim()||option.length>500)||new Set(question.options.map(option=>option.trim().toLowerCase())).size!==4)throw new Error('The model returned invalid answer options. Retry generation.');
    if(!Number.isInteger(question.correctOption)||question.correctOption<0||question.correctOption>3||typeof question.explanation!=='string'||question.explanation.trim().length<8||question.explanation.length>700)throw new Error('The model returned an invalid answer key or explanation. Retry generation.');
    return {id:`q${index+1}`,skill:question.skill,question:question.question.trim(),options:question.options.map(option=>option.trim()),correctOption:question.correctOption,explanation:question.explanation.trim()};
  });
  if(new Set(questions.map(question=>question.question.toLowerCase())).size!==questions.length)throw new Error('The model returned duplicate questions. Retry generation.');
  return questions;
}

const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8', '.svg':'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  const headers = { 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer', 'X-Frame-Options':'DENY', 'Content-Security-Policy':"default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net 'wasm-unsafe-eval'; connect-src 'self' https://api.openai.com https://api.tavily.com https://generativelanguage.googleapis.com https://api.anthropic.com https://storage.googleapis.com https://cdn.jsdelivr.net; media-src 'self' blob:; worker-src 'self' blob:;", 'Cache-Control':'no-store' };
  if (req.url === '/api/auth/register' && req.method === 'POST') {
    try {
      const { email, password, name } = await readBody(req, 20_000); const normalized = String(email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return send(res, 400, { error:'Enter a valid email address.' }, headers);
      if (typeof password !== 'string' || password.length < 12 || password.length > 200) return send(res, 400, { error:'Use a password between 12 and 200 characters.' }, headers);
      const users = loadUsers(); if (users[normalized]) return send(res, 409, { error:'An account with that email already exists.' }, headers);
      const salt = crypto.randomBytes(16); const hash = await scrypt(password, salt, 64);
      users[normalized] = { email:normalized, name:String(name || '').trim().slice(0, 80), salt:salt.toString('hex'), passwordHash:hash.toString('hex'), profile:seal({}), createdAt:new Date().toISOString() }; saveUsers(users);
      const id = crypto.randomBytes(32).toString('hex'); sessions.set(id, { email:normalized, expires:Date.now()+7*86400_000 });
      return send(res, 201, { user:{ email:normalized, name:users[normalized].name } }, { ...headers, 'Set-Cookie':cookieHeader(id) });
    } catch (e) { return send(res, 400, { error:e.message || 'Account creation failed.' }, headers); }
  }
  if (req.url === '/api/auth/login' && req.method === 'POST') {
    try {
      const { email, password } = await readBody(req, 20_000); const normalized = String(email || '').trim().toLowerCase();
      const ip = req.socket.remoteAddress || 'unknown'; const attemptKey = `${ip}:${normalized}`; const a = loginAttempts.get(attemptKey) || { count:0, since:Date.now() };
      if (Date.now()-a.since > 15*60_000) { a.count=0; a.since=Date.now(); }
      if (a.count >= 8) return send(res, 429, { error:'Too many sign-in attempts. Wait 15 minutes and try again.' }, headers);
      const user = loadUsers()[normalized]; const salt = user ? Buffer.from(user.salt,'hex') : Buffer.alloc(16);
      const hash = await scrypt(String(password || ''), salt, 64); const expected = user ? Buffer.from(user.passwordHash,'hex') : Buffer.alloc(64);
      if (!user || !crypto.timingSafeEqual(hash, expected)) { a.count++; loginAttempts.set(attemptKey,a); return send(res, 401, { error:'Email or password is incorrect.' }, headers); }
      loginAttempts.delete(attemptKey); const id=crypto.randomBytes(32).toString('hex'); sessions.set(id,{email:normalized,expires:Date.now()+7*86400_000});
      return send(res, 200, { user:{email:user.email,name:user.name} }, { ...headers, 'Set-Cookie':cookieHeader(id) });
    } catch (e) { return send(res, 400, { error:e.message || 'Sign-in failed.' }, headers); }
  }
  if (req.url === '/api/auth/me' && req.method === 'GET') {
    const session=sessionUser(req); if(!session) return send(res,401,{error:'Sign in to continue.'},headers);
    const user=loadUsers()[session.email]; return send(res,200,{user:{email:user.email,name:user.name}},headers);
  }
  if (req.url === '/api/auth/logout' && req.method === 'POST') {
    const session=sessionUser(req); if(session) sessions.delete(session.id);
    return send(res,200,{ok:true},{...headers,'Set-Cookie':cookieHeader('',0)});
  }
  if (req.url === '/api/profile' && req.method === 'GET') {
    const session=sessionUser(req); if(!session) return send(res,401,{error:'Sign in to continue.'},headers);
    const user=loadUsers()[session.email]; return send(res,200,{profile:unseal(user.profile),name:user.name,email:user.email},headers);
  }
  if (req.url === '/api/dashboard' && req.method === 'GET') {
    const session=sessionUser(req); if(!session) return send(res,401,{error:'Sign in to continue.'},headers);
    const user=loadUsers()[session.email]; const profile=unseal(user.profile);
    const jobs=(Array.isArray(profile.jobs)?profile.jobs:[]).filter(job=>job.source!=='Credixa demo data'&&!/\(sample\)/i.test(String(job.title||''))&&!jobIsExpired({publication_date:job.postedDate})&&validHttpUrl(job.url)).slice(0,12).map(job=>({title:String(job.title||'').slice(0,180),company:String(job.company||'').slice(0,120),location:String(job.location||'').slice(0,120),url:validHttpUrl(job.url),score:job.score!==null&&job.score!==undefined&&Number.isFinite(Number(job.score))?Number(job.score):null,source:String(job.source||'').slice(0,80),requiredSkills:Array.isArray(job.requiredSkills)?job.requiredSkills.slice(0,30):[],matchingSkills:Array.isArray(job.matchingSkills)?job.matchingSkills.slice(0,30):[],missingSkills:Array.isArray(job.missingSkills)?job.missingSkills.slice(0,30):[],requiredQualifications:Array.isArray(job.requiredQualifications)?job.requiredQualifications.slice(0,12):[],matchingQualifications:Array.isArray(job.matchingQualifications)?job.matchingQualifications.slice(0,12):[],missingQualifications:Array.isArray(job.missingQualifications)?job.missingQualifications.slice(0,12):[],postedDate:String(job.postedDate||'').slice(0,80),matchMethod:String(job.matchMethod||'').slice(0,240)}));
    const analysis=profile.analysis||{};
    const safeList=value=>Array.isArray(value)?value.slice(0,20).map(item=>String(item).slice(0,1000)):[];
    const criteria=Array.isArray(analysis.criteria)?analysis.criteria.slice(0,12).map(item=>({label:String(item.label||'').slice(0,100),weight:Number(item.weight)||0,points:Number(item.points)||0,met:!!item.met,detail:String(item.detail||'').slice(0,300)})):[];
    const extracted=analysis.extracted&&typeof analysis.extracted==='object'?{skills:safeList(analysis.extracted.skills),qualifications:safeList(analysis.extracted.qualifications),projects:safeList(analysis.extracted.projects),experience:safeList(analysis.extracted.experience)}:{};
    return send(res,200,{user:{name:user.name,email:user.email},resume:{uploaded:!!profile.resumeText,fileName:profile.fileName||'',fingerprint:profile.hash||'',extracted,criteria,missingKeywords:safeList(analysis.missingKeywords)},atsScore:Number.isFinite(Number(analysis.score))?Number(analysis.score):null,skills:Array.isArray(analysis.skills)?analysis.skills.slice(0,16):[],roles:Array.isArray(analysis.likely_roles)?analysis.likely_roles.slice(0,5):[],jobs},headers);
  }
  if (req.url === '/api/profile' && req.method === 'PUT') {
    const session=sessionUser(req); if(!session) return send(res,401,{error:'Sign in to continue.'},headers);
    try { const profile=await readBody(req,1_500_000); const users=loadUsers(); const user=users[session.email];
      const safe={resumeText:String(profile.resumeText||'').slice(0,40_000),fileName:String(profile.fileName||'').slice(0,180),hash:String(profile.hash||'').slice(0,64),analysis:profile.analysis||null,preferences:profile.preferences||{},jobs:Array.isArray(profile.jobs)?profile.jobs.filter(j=>j.source!=='Credixa demo data'&&!/\(sample\)/i.test(String(j.title||''))&&!jobIsExpired({publication_date:j.postedDate})&&validHttpUrl(j.url)).slice(0,12).map(j=>({title:String(j.title||'').slice(0,180),company:String(j.company||'').slice(0,120),location:String(j.location||'').slice(0,120),url:validHttpUrl(j.url),score:j.score!==null&&j.score!==undefined&&Number.isFinite(Number(j.score))?Number(j.score):null,source:String(j.source||'').slice(0,80),requiredSkills:Array.isArray(j.requiredSkills)?j.requiredSkills.slice(0,30).map(v=>String(v).slice(0,100)):[],matchingSkills:Array.isArray(j.matchingSkills)?j.matchingSkills.slice(0,30).map(v=>String(v).slice(0,100)):[],missingSkills:Array.isArray(j.missingSkills)?j.missingSkills.slice(0,30).map(v=>String(v).slice(0,100)):[],requiredQualifications:Array.isArray(j.requiredQualifications)?j.requiredQualifications.slice(0,12).map(v=>String(v).slice(0,120)):[],matchingQualifications:Array.isArray(j.matchingQualifications)?j.matchingQualifications.slice(0,12).map(v=>String(v).slice(0,120)):[],missingQualifications:Array.isArray(j.missingQualifications)?j.missingQualifications.slice(0,12).map(v=>String(v).slice(0,120)):[],postedDate:String(j.postedDate||'').slice(0,80),matchMethod:String(j.matchMethod||'').slice(0,240)})):[]};
      const previousProfile=unseal(user.profile);
      safe.assessments=Array.isArray(previousProfile.assessments)?previousProfile.assessments.slice(-20):[];
      safe.proctoringEvents=Array.isArray(previousProfile.proctoringEvents)?previousProfile.proctoringEvents.slice(-500):[];
      safe.verificationRecords=Array.isArray(previousProfile.verificationRecords)?previousProfile.verificationRecords.slice(-20):[];
      user.profile=seal(safe); if(profile.name)user.name=String(profile.name).trim().slice(0,80); saveUsers(users);
      return send(res,200,{ok:true},headers);
    } catch(e) { return send(res,400,{error:e.message||'Could not save profile.'},headers); }
  }
  if(req.url==='/api/assessments'&&req.method==='GET'){
    const session=sessionUser(req);if(!session)return send(res,401,{error:'Sign in to continue.'},headers);
    const user=loadUsers()[session.email];const profile=unseal(user.profile);const analysis=profile.analysis||{};
    const skills=[...new Set([...(analysis.extracted?.skills||[]),...(analysis.skills||[])].filter(skill=>typeof skill==='string'&&skill.trim()))].slice(0,40);
    const reports=Array.isArray(profile.assessments)?profile.assessments.slice(-20).reverse():[];
    const proctoringEvents=Array.isArray(profile.proctoringEvents)?profile.proctoringEvents.slice(-100).reverse():[];
    return send(res,200,{skills,reports,proctoringEvents},headers);
  }
  if(req.url==='/api/verifications'&&req.method==='POST'){
    const session=sessionUser(req);if(!session)return send(res,401,{error:'Sign in to create a verification record.'},headers);
    try{
      const body=await readBody(req,10_000);const users=loadUsers();const user=users[session.email];const profile=unseal(user.profile);const analysis=profile.analysis||{};
      if(!profile.resumeText)return send(res,400,{error:'Upload and save a resume before creating a verification record.'},headers);
      const resumeSkills=[...new Set([...(analysis.extracted?.skills||[]),...(analysis.skills||[])].filter(skill=>typeof skill==='string'&&skill.trim()))].slice(0,40);
      if(!resumeSkills.length)return send(res,400,{error:'Analyze your resume to extract skills before creating a verification record.'},headers);
      const reports=Array.isArray(profile.assessments)?profile.assessments.filter(report=>!report.terminated&&Array.isArray(report.perSkill)):[];
      const outcomeBySkill=new Map();
      for(const report of reports.sort((a,b)=>Date.parse(a.completedAt||0)-Date.parse(b.completedAt||0))){
        for(const result of report.perSkill){
          if(!resumeSkills.includes(result.skill))continue;
          // Skill passes if it meets 80% threshold (regardless of total question count)
          const passed=result.criteriaMet===true && result.status==='assessment_criteria_met' && Number(result.percentage)>=80 && Number(result.total) > 0;
          outcomeBySkill.set(result.skill,{skill:result.skill,status:passed?'verified':'not_verified',score:passed?Number(result.percentage):Number(result.percentage)||0,correct:Number(result.correct)||0,total:Number(result.total)||0,difficulty:String(report.difficulty||'unknown').slice(0,20),assessmentDate:String(report.completedAt||'')});
        }
      }
      const skills=resumeSkills.map(skill=>outcomeBySkill.get(skill)||{skill,status:'not_assessed',score:null,correct:0,total:0,difficulty:'',assessmentDate:''});
      const assessmentDate=skills.map(item=>item.assessmentDate).filter(Boolean).sort().at(-1)||'';
      const verificationId=crypto.randomBytes(24).toString('hex');
      const record={schemaVersion:1,verificationId,resumeSha256:crypto.createHash('sha256').update(profile.resumeText,'utf8').digest('hex'),skills,assessmentDate,verificationStatus:'assessment_results_recorded'};
      const recordHash=verificationHash(record);
      const publicBase=(process.env.PUBLIC_BASE_URL||'').trim().replace(/\/$/,'');
      if(!/^(https:\/\/|http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?)/i.test(publicBase))return send(res,503,{error:'Set PUBLIC_BASE_URL to the HTTPS address (or http://localhost:port for local testing) reachable before creating a QR verification record.'},headers);
      const stored={record,recordHash,blockchain:{status:'not_anchored',transactionHash:'',anchoredAt:''},createdAt:new Date().toISOString()};
      profile.verificationRecords=Array.isArray(profile.verificationRecords)?profile.verificationRecords:[];profile.verificationRecords.push(stored);profile.verificationRecords=profile.verificationRecords.slice(-20);user.profile=seal(profile);saveUsers(users);
      return send(res,201,{verificationId,recordHash,skills,assessmentDate,publicUrl:publicBase?`${publicBase}/verify/${verificationId}`:'',publicUrlConfigured:!!publicBase,ledgerConfigured:!!(process.env.EVM_RPC_URL&&process.env.RESUME_REGISTRY_ADDRESS)},headers);
    }catch(error){return send(res,400,{error:error.message||'Could not create a verification record.'},headers);}
  }
  if(req.url.startsWith('/api/verifications/')&&req.method==='POST'&&req.url.endsWith('/confirm')){
    const session=sessionUser(req);if(!session)return send(res,401,{error:'Sign in to anchor the verification record.'},headers);
    const verificationId=req.url.split('/')[3]||'';
    if(!/^[a-f0-9]{48}$/.test(verificationId))return send(res,400,{error:'Invalid verification ID.'},headers);
    try{
      const body=await readBody(req,10_000);const users=loadUsers();const user=users[session.email];const profile=unseal(user.profile);const entry=(profile.verificationRecords||[]).find(item=>item.record?.verificationId===verificationId);
      if(!entry)return send(res,404,{error:'Verification record not found.'},headers);
      if(verificationHash(entry.record)!==entry.recordHash)return send(res,409,{error:'Stored verification record has changed; refusing to anchor it.'},headers);
      const txHash=String(body.transactionHash||'');if(!/^0x[0-9a-fA-F]{64}$/.test(txHash))return send(res,400,{error:'A valid confirmed wallet transaction hash is required.'},headers);
      const {provider,address,contract,interface:contractInterface}=verificationContract();
      const receipt=await provider.getTransactionReceipt(txHash);
      if(!receipt||receipt.status!==1)return send(res,409,{error:'Transaction is not confirmed successfully on the configured network.'},headers);
      const targetHash=`0x${entry.recordHash}`;const emitted=receipt.logs.some(log=>{
        if(String(log.address).toLowerCase()!==address.toLowerCase())return false;
        try{return contractInterface.parseLog(log)?.args?.resumeHash?.toLowerCase()===targetHash.toLowerCase()}catch{return false;}
      });
      if(!emitted)return send(res,409,{error:'Confirmed transaction does not contain a ResumeRegistry event for this verification record hash.'},headers);
      const [owner,timestamp]=await contract.records(targetHash);
      if(timestamp===0n)return send(res,409,{error:'ResumeRegistry does not contain the verification record hash.'},headers);
      const network=await provider.getNetwork();entry.blockchain={status:'anchored',transactionHash:txHash,anchoredAt:new Date(Number(timestamp)*1000).toISOString(),chainId:network.chainId.toString()};
      user.profile=seal(profile);saveUsers(users);
      return send(res,200,{ok:true,verificationId,recordHash:entry.recordHash,blockchainStatus:'anchored',chainId:network.chainId.toString()},headers);
    }catch(error){return send(res,503,{error:error.message||'Ledger connection or verification failed.'},headers);}
  }
  if(req.url==='/api/verifications'&&req.method==='GET'){
    const session=sessionUser(req);if(!session)return send(res,401,{error:'Sign in to load verification records.'},headers);
    const user=loadUsers()[session.email];const profile=unseal(user.profile);const publicBase=(process.env.PUBLIC_BASE_URL||'').trim().replace(/\/$/,'');
    const records=(profile.verificationRecords||[]).slice(-10).reverse().map(item=>({verificationId:item.record.verificationId,record:item.record,recordHash:item.recordHash,skills:item.record.skills,assessmentDate:item.record.assessmentDate,blockchainStatus:item.blockchain?.status||'not_anchored',transactionHash:item.blockchain?.transactionHash||'',publicUrl:publicBase?`${publicBase}/verify/${item.record.verificationId}`:'',createdAt:item.createdAt}));
    return send(res,200,{records,publicUrlConfigured:!!publicBase,ledgerConfigured:!!(process.env.EVM_RPC_URL&&process.env.RESUME_REGISTRY_ADDRESS)},headers);
  }
  if(req.method==='GET'&&req.url.startsWith('/api/public-verifications/')){
    const verificationId=req.url.split('/')[3]||'';
    if(!/^[a-f0-9]{48}$/.test(verificationId))return send(res,400,{status:'invalid_id',message:'This verification link is invalid.'},headers);
    let found=null;
    for(const user of Object.values(loadUsers())){
      try{const profile=unseal(user.profile);const entry=(profile.verificationRecords||[]).find(item=>item.record?.verificationId===verificationId);if(entry){found={...entry,currentResumeHash:crypto.createHash('sha256').update(String(profile.resumeText||''),'utf8').digest('hex')};break;}}catch{}
    }
    if(!found)return send(res,404,{status:'record_not_found',message:'No public verification record exists for this ID.'},headers);
    if(verificationHash(found.record)!==found.recordHash)return send(res,200,{status:'record_modified',verificationId,message:'The stored verification record no longer matches its saved SHA-256 digest. Integrity could not be verified.'},headers);
    if(found.currentResumeHash!==found.record.resumeSha256)return send(res,200,{status:'resume_modified',verificationId,message:'The current saved resume text differs from the resume snapshot associated with this verification record.'},headers);
    const verifiedSkills=found.record.skills.filter(item=>item.status==='verified').map(item=>({skill:item.skill,assessmentDate:item.assessmentDate,difficulty:item.difficulty,score:item.score}));
    if(found.blockchain?.status!=='anchored')return send(res,200,{status:'not_anchored',verificationId,verifiedSkills,assessmentDate:found.record.assessmentDate,message:'Assessment data is available, but this record has not been anchored to the configured blockchain.'},headers);
    try{
      const {contract}=verificationContract();const [owner,timestamp]=await contract.records(`0x${found.recordHash}`);
      if(timestamp===0n)return send(res,200,{status:'ledger_record_missing',verificationId,verifiedSkills,assessmentDate:found.record.assessmentDate,message:'The verification hash is not present in the ResumeRegistry contract.'},headers);
      return send(res,200,{status:'integrity_match',verificationId,verifiedSkills,assessmentDate:found.record.assessmentDate,anchoredAt:found.blockchain.anchoredAt,message:'The current off-chain verification record matches the hash recorded in ResumeRegistry. This confirms record integrity only; it does not prove identity or skill authenticity.'},headers);
    }catch(error){return send(res,200,{status:'ledger_unavailable',verificationId,verifiedSkills,assessmentDate:found.record.assessmentDate,message:'The record exists, but the blockchain could not be reached to validate its integrity.'},headers);}
  }
  if(req.method==='GET'&&/^\/verify\/[a-f0-9]{48}\/?$/.test(new URL(req.url,'http://localhost').pathname)){
    const verifyFile=path.join(root,'verify.html');res.writeHead(200,{...headers,'Content-Type':'text/html; charset=utf-8'});fs.createReadStream(verifyFile).pipe(res);return;
  }
  if(req.method==='GET'&&req.url==='/vendor/jspdf.umd.min.js'){
    const file=path.resolve(projectRoot,'node_modules/jspdf/dist/jspdf.umd.min.js');res.writeHead(200,{...headers,'Content-Type':'text/javascript; charset=utf-8'});fs.createReadStream(file).pipe(res);return;
  }
  if(req.method==='GET'&&req.url==='/vendor/qrcode.min.js'){
    const file=path.resolve(projectRoot,'node_modules/qrcode-generator/dist/qrcode.js');res.writeHead(200,{...headers,'Content-Type':'text/javascript; charset=utf-8'});fs.createReadStream(file).pipe(res);return;
  }
  if(req.url==='/api/assessments/start'&&req.method==='POST'){
    const session=sessionUser(req);if(!session)return send(res,401,{error:'Sign in to continue.'},headers);
    try{
      const body=await readBody(req,30_000);const user=loadUsers()[session.email];const profile=unseal(user.profile);const analysis=profile.analysis||{};
      const available=[...new Set([...(analysis.extracted?.skills||[]),...(analysis.skills||[])].filter(skill=>typeof skill==='string'&&skill.trim()))];
      
      // Use provided skills if explicitly specified (for testing), otherwise use all available resume skills
      const skills = (body.skills && Array.isArray(body.skills) && body.skills.length > 0)
        ? body.skills.filter(skill => available.includes(skill))  // Validate against resume
        : available.slice(0, 10);  // Default: use all resume skills (max 10)
      
      if(!profile.resumeText||!skills.length)return send(res,400,{error:'Upload and analyze a resume with detectable skills before starting an assessment.'},headers);
      if(!['beginner','intermediate','advanced'].includes(body.difficulty))return send(res,400,{error:'Choose beginner, intermediate, or advanced difficulty.'},headers);
      
      // Accept total question count (20, 30, or 50)
      const totalQuestions = Number(body.totalQuestions);
      if(![20, 30, 50].includes(totalQuestions))return send(res,400,{error:'Choose 20, 30, or 50 total questions.'},headers);
      
      // Calculate dynamic time limit based on question count (1 minute per question + 5 minute buffer)
      const minutes = totalQuestions + 5;
      
      const thirdWarningAction=body.thirdWarningAction==='terminate'?'terminate':'submit';
      
      // Distribute questions across skills
      const questionDistribution = distributeQuestions(skills, totalQuestions);
      
      const questions=await requestAssessmentQuestions({
        provider:body.provider,
        apiKey:body.apiKey,
        model:body.model,
        skills,
        difficulty:body.difficulty,
        questionDistribution
      });
      
      const assessmentId=crypto.randomBytes(24).toString('hex');
      pendingAssessments.set(assessmentId,{
        assessmentId,
        email:session.email,
        skills,
        difficulty:body.difficulty,
        minutes,
        totalQuestions,
        questionDistribution,
        thirdWarningAction,
        questions,
        startedAt:Date.now(),
        events:[],
        warnings:0,
        lastWarningAt:new Map(),
        terminated:false,
        submitted:false
      });
      
      for(const[id,pending] of pendingAssessments)if(Date.now()-pending.startedAt>2*60*60*1000||pending.submitted)pendingAssessments.delete(id);
      
      return send(res,201,{
        assessmentId,
        skills,
        difficulty:body.difficulty,
        minutes,
        totalQuestions,
        questionDistribution,
        thirdWarningAction,
        questions:questions.map(({id,skill,question,options})=>({id,skill,question,options})),
        startedAt:new Date().toISOString()
      },headers);
    }catch(error){return send(res,502,{error:error.message||'Assessment generation failed. Check your LLM configuration and retry.'},headers);}
  }
  if(req.url==='/api/assessments/events'&&req.method==='POST'){
    const session=sessionUser(req);if(!session)return send(res,401,{error:'Sign in to continue.'},headers);
    try{
      const body=await readBody(req,10_000);const pending=pendingAssessments.get(String(body.assessmentId||''));
      if(!pending||pending.email!==session.email||pending.submitted)return send(res,404,{error:'Assessment session not found or already closed.'},headers);
      const type=String(body.type||'');const allowed=new Set(['tab_hidden','face_absent','multiple_faces','head_turned','camera_permission_denied','camera_error','face_model_unavailable','camera_unavailable']);
      if(!allowed.has(type))return send(res,400,{error:'Unsupported proctoring event.'},headers);
      const details=String(body.details||'').slice(0,180);const durationMs=Math.max(0,Math.min(120_000,Number(body.durationMs)||0));
      const thresholds={tab_hidden:2000,face_absent:5000,multiple_faces:2000,head_turned:4000};
      const qualifies=Object.hasOwn(thresholds,type)&&durationMs>=thresholds[type];
      const now=Date.now();const previous=pending.lastWarningAt.get(type)||0;const cooldownPassed=now-previous>=8000;
      let warningNumber=null;let action='recorded';
      if(qualifies&&cooldownPassed){pending.warnings=Math.min(3,pending.warnings+1);warningNumber=pending.warnings;pending.lastWarningAt.set(type,now);action=warningNumber===3?pending.thirdWarningAction:'warn';if(warningNumber===3&&action==='terminate')pending.terminated=true;}
      const event={type,details,durationMs,createdAt:new Date(now).toISOString(),qualifying:qualifies&&cooldownPassed,warningNumber,action};
      pending.events.push(event);
      if(pending.events.length>150)pending.events.shift();
      const users=loadUsers();const user=users[session.email];const profile=unseal(user.profile);profile.proctoringEvents=Array.isArray(profile.proctoringEvents)?profile.proctoringEvents:[];profile.proctoringEvents.push({...event,assessmentId:pending.assessmentId,skills:pending.skills});profile.proctoringEvents=profile.proctoringEvents.slice(-500);user.profile=seal(profile);saveUsers(users);
      return send(res,200,{warnings:pending.warnings,warningNumber,action,terminated:pending.terminated},headers);
    }catch(error){return send(res,400,{error:error.message||'Could not record proctoring event.'},headers);}
  }
  if(req.url==='/api/assessments/submit'&&req.method==='POST'){
    const session=sessionUser(req);if(!session)return send(res,401,{error:'Sign in to continue.'},headers);
    try{
      const body=await readBody(req,30_000);const pending=pendingAssessments.get(String(body.assessmentId||''));
      if(!pending||pending.email!==session.email||pending.submitted)return send(res,404,{error:'Assessment session not found or already submitted.'},headers);
      const elapsedMs=Math.max(0,Date.now()-pending.startedAt);const expired=elapsedMs>pending.minutes*60_000+5000;
      if(expired&&pending.events.length<150)pending.events.push({type:'time_expired',details:'Assessment time limit reached.',durationMs:0,createdAt:new Date().toISOString(),qualifying:false,warningNumber:null,action:'submit'});
      if(body.terminated===true&&pending.thirdWarningAction==='terminate')pending.terminated=true;
      const answers=body.answers&&typeof body.answers==='object'?body.answers:{};
      
      // Calculate per-skill scores with dynamic question counts
      const perSkill=pending.skills.map(skill=>{
        const questions=pending.questions.filter(question=>question.skill===skill);
        const correct=questions.filter(question=>Number.isInteger(answers[question.id])&&answers[question.id]===question.correctOption).length;
        const percentage=questions.length > 0 ? Math.round(correct/questions.length*100) : 0;
        
        // Apply 80% threshold per skill (regardless of total question count)
        const criteriaMet=!pending.terminated && questions.length > 0 && percentage >= 80;
        
        return {
          skill,
          correct,
          total:questions.length,
          percentage,
          criteriaMet,
          status:criteriaMet?'assessment_criteria_met':'criteria_not_met'
        };
      });
      
      const totalCorrect=perSkill.reduce((sum,result)=>sum+result.correct,0);
      const totalQuestions=pending.questions.length;
      
      const report={
        id:crypto.randomBytes(12).toString('hex'),
        difficulty:pending.difficulty,
        skills:pending.skills,
        totalQuestions:pending.totalQuestions,
        questionDistribution:pending.questionDistribution,
        startedAt:new Date(pending.startedAt).toISOString(),
        completedAt:new Date().toISOString(),
        durationSeconds:Math.round(elapsedMs/1000),
        timeLimitMinutes:pending.minutes,
        score:pending.terminated?null:Math.round(totalCorrect/totalQuestions*100),
        correct:pending.terminated?null:totalCorrect,
        total:pending.terminated?null:totalQuestions,
        terminated:pending.terminated,
        terminationReason:pending.terminated?'Third warning action configured to terminate; results not scored.':'',
        perSkill:pending.terminated?perSkill.map(result=>({...result,percentage:null,criteriaMet:false,status:'not_scored'})):perSkill,
        events:pending.events,
        warningCount:pending.warnings,
        thirdWarningAction:pending.thirdWarningAction,
        scoringRule:'One point per correct answer; per-skill assessment criteria require at least 80% correct across all questions for that skill. Assessment evidence does not establish identity.'
      };
      
      const users=loadUsers();const user=users[session.email];const profile=unseal(user.profile);
      profile.assessments=Array.isArray(profile.assessments)?profile.assessments:[];
      profile.assessments.push(report);
      profile.assessments=profile.assessments.slice(-20);
      user.profile=seal(profile);
      saveUsers(users);
      pending.submitted=true;
      pendingAssessments.delete(String(body.assessmentId));
      
      return send(res,200,{report},headers);
    }catch(error){return send(res,400,{error:error.message||'Could not submit assessment.'},headers);}
  }
  if (req.method === 'POST' && req.url === '/api/llm') {
    if (!sessionUser(req)) return send(res,401,{error:'Sign in to continue.'},headers);
    let body=''; req.on('data', chunk => { body+=chunk; if (body.length > 2_000_000) req.destroy(); });
    req.on('end', async () => {
      try {
        const { provider, apiKey, model, messages } = JSON.parse(body);
        if (!apiKey || !Array.isArray(messages)) throw new Error('Add your model API key and try again.');
        let url, payload, hdr;
        if (provider === 'anthropic') { url='https://api.anthropic.com/v1/messages'; hdr={'x-api-key':apiKey,'anthropic-version':'2023-06-01','content-type':'application/json'}; payload={model:model||'claude-3-5-sonnet-latest',max_tokens:2400,messages:messages.map(m=>({role:m.role,content:m.content}))}; }
        else if (provider === 'gemini') { url=`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model||'gemini-3.8-flash')}:generateContent?key=${encodeURIComponent(apiKey)}`; hdr={'content-type':'application/json'}; payload={contents:messages.map(m=>({role:m.role==='assistant'?'model':'user',parts:[{text:m.content}]})),generationConfig:{maxOutputTokens:2400,responseMimeType:'application/json'}}; }
        else { url=process.env.OPENAI_API_BASE_URL||'https://api.openai.com/v1/chat/completions'; hdr={'Authorization':`Bearer ${apiKey}`,'content-type':'application/json'}; payload={model:model||'gpt-4o-mini',messages,temperature:0.25,response_format:{type:'json_object'}}; }
        const upstream=await fetch(url,{method:'POST',headers:hdr,body:JSON.stringify(payload)});
        const data=await upstream.json(); if(!upstream.ok) throw new Error(data.error?.message||data.message||`Provider returned ${upstream.status}`);
        const content=provider==='anthropic'?data.content?.find(x=>x.type==='text')?.text:provider==='gemini'?data.candidates?.[0]?.content?.parts?.[0]?.text:data.choices?.[0]?.message?.content;
        if(!content) throw new Error('The model returned an empty response.');
        res.writeHead(200,{...headers,'Content-Type':'application/json'}); res.end(JSON.stringify({content}));
      } catch(e) { res.writeHead(400,{...headers,'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.message||'Request failed'})); }
    }); return;
  }
  if (req.method === 'POST' && req.url === '/api/search') {
    if (!sessionUser(req)) return send(res,401,{error:'Sign in to continue.'},headers);
    try {
      const {apiKey,query,location,candidateSkills=[],candidateQualifications=[]}=await readBody(req,100_000); let output=null;
      const requestedLocation=location||'India';
      const searchTerms=[query,...candidateSkills,...candidateQualifications].filter(value=>typeof value==='string').join(' ').slice(0,4000);
      if(apiKey) {
        try { const r=await fetch('https://api.tavily.com/search',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({api_key:apiKey,query:`${searchTerms} jobs internships in ${requestedLocation} careers hiring`,search_depth:'advanced',topic:'general',max_results:20,include_answer:false,include_raw_content:true}),signal:AbortSignal.timeout(9000)});const d=await r.json();if(!r.ok)throw new Error(d.detail||d.message||`Search provider returned ${r.status}`);const indiaPattern=/\b(india|bengaluru|bangalore|mumbai|delhi|hyderabad|chennai|pune|kolkata|ahmedabad|noida|gurugram|gurgaon|kochi|jaipur|indore|chandigarh|mysore|mysuru|mangalore|visakhapatnam|bhubaneswar|thiruvananthapuram|coimbatore|nagpur)\b/i;const scoped=(d.results||[]).filter(x=>x.title&&validHttpUrl(x.url)&&looksLikeJobPosting(x)&&!jobIsExpired({publication_date:x.published_date,expiration_date:x.expiration_date})&&(requestedLocation.toLowerCase()==='india'?indiaPattern.test(`${x.title} ${x.content} ${x.url}`):jobFitsLocation({candidate_required_location:x.content||'',title:x.title},requestedLocation)));if(scoped.length)output={source:'tavily',results:scoped.map(x=>({title:String(x.title).slice(0,180),url:validHttpUrl(x.url),content:plainText(x.raw_content||x.content||'').slice(0,5000),published_date:String(x.published_date||''),company:'',location:'',source:'Tavily web search'})),notice:'Tavily web results; verify each opening and application details on the linked employer page.'}; }
        catch(e){ console.warn('Configured web search failed; trying public remote jobs feed:',e.message); }
      }
      if(!output)output=await getJobResults(searchTerms,requestedLocation);
      return send(res,output.unavailable?503:200,output,headers);
    } catch(e) { return send(res,400,{error:e.message||'Search request could not be completed.'},headers); }
  }
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  
  // Route mapping for new page structure
  let file;
  if (pathname === '/') {
    file = path.resolve(root, 'landing.html'); // Landing page
  } else if (pathname === '/auth') {
    file = path.resolve(root, 'auth.html');
  } else if (pathname === '/dashboard') {
    file = path.resolve(root, 'main-dashboard.html');
  } else if (pathname === '/resume-studio') {
    file = path.resolve(root, 'resume-studio.html');
  } else if (pathname === '/skill-assessment') {
    file = path.resolve(root, 'skill-assessment.html');
  } else if (pathname === '/manage-verifications') {
    file = path.resolve(root, 'manage-verifications.html');
  } else if (pathname === '/verified-resume') {
    file = path.resolve(root, 'index.html'); // Keep original functionality for backward compatibility
  } else {
    file = path.resolve(root, pathname.replace(/^\/+/, ''));
  }
  
  const relative = path.relative(root, file);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404,headers); res.end('Not found'); return; }
  res.writeHead(200,{...headers,'Content-Type':mime[path.extname(file)]||'application/octet-stream'}); fs.createReadStream(file).pipe(res);
});
const port=Number(process.env.PORT)||3000;
server.listen(port,'127.0.0.1',()=>console.log(`Credixa ready at http://localhost:${port}`));
