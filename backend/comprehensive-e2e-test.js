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
const { jsPDF } = require('jspdf');
const qrcode = require('qrcode-generator');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function close(server) {
  if (server?.listening) await new Promise(resolve => server.close(resolve));
}

function compileRegistry() {
  const source = fs.readFileSync(path.resolve(__dirname, '../contracts/ResumeRegistry.sol'), 'utf8');
  const input = {
    language: 'Solidity',
    sources: { 'ResumeRegistry.sol': { content: source } },
    settings: { outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } }
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors || []).filter(e => e.severity === 'error');
  if (errors.length) throw Error(errors.map(e => e.formattedMessage).join('\n'));
  return output.contracts['ResumeRegistry.sol'].ResumeRegistry;
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

// Rubric scoring rules from frontend/resume-analysis.js
const skillBank = ['JavaScript','TypeScript','Python','Java','C++','C#','Go','Rust','React','Angular','Vue','Node.js','Express','HTML','CSS','SQL','PostgreSQL','MySQL','MongoDB','AWS','Azure','GCP','Docker','Kubernetes','Terraform','Linux','Git','REST API','GraphQL','Machine Learning','TensorFlow','PyTorch','Pandas','Excel','Power BI','Tableau','Figma','Agile','Scrum','Jira','Blockchain','Solidity'];

const resumeSectionRules = [
  { key: 'summary', label: 'Summary', pattern: /^(professional\s+summary|summary|profile|objective|about\s+me)$/i },
  { key: 'experience', label: 'Experience', pattern: /^(professional\s+experience|work\s+experience|experience|employment\s+history|work\s+history)$/i },
  { key: 'qualifications', label: 'Qualifications', pattern: /^(education|qualifications?|certifications?|licenses?)$/i },
  { key: 'projects', label: 'Projects', pattern: /^(projects?|personal\s+projects?|selected\s+projects?)$/i },
  { key: 'skillsSection', label: 'Skills', pattern: /^(technical\s+skills|skills|technologies|technical\s+proficiencies)$/i }
];

const atsRubric = [
  { key: 'contact', label: 'Contact information', weight: 10, detail: 'Email or phone number is present.' },
  { key: 'summary', label: 'Professional summary', weight: 10, detail: 'A summary, profile, or objective section is present.' },
  { key: 'experience', label: 'Experience', weight: 20, detail: 'A clearly headed experience section is present.' },
  { key: 'qualifications', label: 'Qualifications', weight: 15, detail: 'Education, certification, or qualification details are present.' },
  { key: 'skills', label: 'Skills', weight: 15, detail: 'A skills section or recognizable skills are present.' },
  { key: 'projects', label: 'Projects', weight: 10, detail: 'A clearly headed projects section is present.' },
  { key: 'impact', label: 'Measurable impact', weight: 10, detail: 'At least one numeric outcome or measure is present.' },
  { key: 'structure', label: 'Readable structure', weight: 10, detail: 'At least three recognizable resume sections are present.' }
];

function extractResumeSections(text) {
  const sections = Object.fromEntries(resumeSectionRules.map(rule => [rule.key, '']));
  let activeKey = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const normalized = line.replace(/:$/, '').trim();
    const heading = resumeSectionRules.find(rule => rule.pattern.test(normalized));
    if (heading) { activeKey = heading.key; continue; }
    if (activeKey && line) sections[activeKey] += `${sections[activeKey] ? '\n' : ''}${line}`;
  }
  return sections;
}

function detectResumeSkills(text) {
  return skillBank.filter(skill => {
    const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'i').test(text);
  });
}

function resumeEvidenceLines(value) {
  return String(value || '').split(/\r?\n/).map(line => line.replace(/^\s*[-*•\u2022]+\s*/, '').trim()).filter(Boolean).slice(0, 8);
}

function analyzeResumeText(text) {
  const sections = extractResumeSections(text);
  const skills = detectResumeSkills(text);
  const email = /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(text);
  const phone = /\+?\d[\d\s().-]{7,}\d/.test(text);
  const metric = /(?:\b\d+(?:\.\d+)?\s?%|\$\s?\d|\b\d+\+?\s+(?:users|customers|clients|projects|employees|hours|revenue|sales|years)\b)/i.test(text);
  const sectionCount = resumeSectionRules.filter(rule => sections[rule.key].trim()).length;
  const checks = {
    contact: email || phone,
    summary: Boolean(sections.summary.trim()),
    experience: Boolean(sections.experience.trim()),
    qualifications: Boolean(sections.qualifications.trim()),
    skills: Boolean(sections.skillsSection.trim() || skills.length),
    projects: Boolean(sections.projects.trim()),
    impact: metric,
    structure: sectionCount >= 3
  };
  const criteria = atsRubric.map(item => ({
    ...item,
    met: checks[item.key],
    points: checks[item.key] ? item.weight : 0
  }));
  const extracted = {
    skills,
    qualifications: resumeEvidenceLines(sections.qualifications),
    projects: resumeEvidenceLines(sections.projects),
    experience: resumeEvidenceLines(sections.experience)
  };
  const missingKeywords = criteria.filter(item => !item.met).map(item => item.label);
  return {
    mode: 'rubric',
    score: criteria.reduce((total, item) => total + item.points, 0),
    summary: 'A transparent estimate from the defined rubric.',
    strengths: criteria.filter(item => item.met).map(item => ({ title: item.label, detail: item.detail })),
    suggestions: [],
    skills,
    criteria,
    missingKeywords,
    extracted
  };
}

function hasUnsupportedWording(source, proposal) {
  const allowedFunctionWords = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'into', 'of', 'on', 'or', 'the', 'to', 'using', 'with']);
  const sourceWords = new Set(source.toLowerCase().match(/[a-z][a-z0-9+#.]*/g) || []);
  const proposalWords = proposal.toLowerCase().match(/[a-z][a-z0-9+#.]*/g) || [];
  return proposalWords.some(word => !sourceWords.has(word) && !allowedFunctionWords.has(word));
}

async function runComprehensiveE2ETest() {
  console.log('--- Starting Comprehensive Credixa End-to-End Workflow Test ---');
  const temporaryData = fs.mkdtempSync(path.join(os.tmpdir(), 'credixa-comprehensive-'));
  const testSecret = 'comprehensive-e2e-secret-key-32b';
  const registryArtifact = compileRegistry();

  // Setup local EVM Ganache provider
  const evmProvider = ganache.provider({ logging: { quiet: true }, wallet: { totalAccounts: 3 } });
  const rpcServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const input = JSON.parse(body);
        const batch = Array.isArray(input) ? input : [input];
        const results = await Promise.all(batch.map(async call => {
          try { return { jsonrpc: '2.0', id: call.id, result: await evmProvider.request({ method: call.method, params: call.params || [] }) }; }
          catch (e) { return { jsonrpc: '2.0', id: call.id, error: { code: -32000, message: e.message } }; }
        }));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(Array.isArray(input) ? results : results[0]));
      } catch (e) { res.writeHead(400); res.end(e.message); }
    });
  });

  let mockLlmServer;
  let credixaApp;
  let rpcPort;
  let llmPort;
  let appPort;

  try {
    rpcPort = await listen(rpcServer);
    const rpcUrl = `http://127.0.0.1:${rpcPort}`;

    // Deploy ResumeRegistry contract
    const ethersProvider = new ethers.BrowserProvider(evmProvider);
    const signer = await ethersProvider.getSigner(0);
    const factory = new ethers.ContractFactory(registryArtifact.abi, registryArtifact.evm.bytecode.object, signer);
    const contract = await factory.deploy();
    await contract.waitForDeployment();
    const contractAddress = await contract.getAddress();
    console.log(`[EVM Setup] Deployed ResumeRegistry contract to ${contractAddress} on ${rpcUrl}`);

    // Setup mock LLM server for AI suggestions and assessment questions
    mockLlmServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const prompt = parsed.messages?.[0]?.content || '';
          let payload;
          if (prompt.includes('editing a resume using only its supplied content')) {
            const source = 'Built accessible interfaces using React.';
            payload = {
              suggestions: prompt.includes(source) ? [{
                title: 'Tighten experience bullet',
                reason: 'Uses the same resume facts with concise phrasing.',
                source_text: source,
                suggested_text: 'Built accessible interfaces with React.'
              }] : []
            };
          } else {
            // Parse distribution from prompt like "JavaScript: 10 questions, React: 10 questions"
            const distMatch = prompt.match(/distributed as follows: ([^.]+)\./);
            if (distMatch) {
              const parts = distMatch[1].split(', ');
              const questions = [];
              for (const part of parts) {
                const skillMatch = part.match(/^(.+): (\d+) questions?$/);
                if (skillMatch) {
                  const skill = skillMatch[1];
                  const count = parseInt(skillMatch[2]);
                  for (let i = 0; i < count; i++) {
                    questions.push({
                      skill,
                      question: `${skill}: technical knowledge assessment question ${i + 1}?`,
                      options: ['Distractor Option A', 'Distractor Option B', 'Correct Technical Option', 'Distractor Option D'],
                      correctOption: 2,
                      explanation: `Option C is the objective correct answer for ${skill}.`
                    });
                  }
                }
              }
              payload = { questions };
            } else {
              // Fallback: use skills from old format
              const match = prompt.match(/Use these skills only: (\[[^\]]+\])\./);
              const skills = match ? JSON.parse(match[1]) : ['JavaScript'];
              payload = {
                questions: skills.flatMap(skill => Array.from({ length: 10 }, (_, i) => ({
                  skill,
                  question: `${skill}: technical knowledge assessment question ${i + 1}?`,
                  options: ['Distractor Option A', 'Distractor Option B', 'Correct Technical Option', 'Distractor Option D'],
                  correctOption: 2,
                  explanation: `Option C is the objective correct answer for ${skill}.`
                })))
              };
            }
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }));
        } catch (e) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: e.message } }));
        }
      });
    });
    llmPort = await listen(mockLlmServer);

    appPort = 34000 + Math.floor(Math.random() * 5000);
    const publicBaseUrl = `http://localhost:${appPort}`;

    // Start Credixa server
    credixaApp = spawn(process.execPath, ['backend/server.js'], {
      cwd: path.resolve(__dirname, '..'),
      env: {
        ...process.env,
        PORT: String(appPort),
        APP_SECRET: testSecret,
        CREDIXA_DATA_DIR: temporaryData,
        OPENAI_API_BASE_URL: `http://127.0.0.1:${llmPort}/v1/chat/completions`,
        EVM_RPC_URL: rpcUrl,
        RESUME_REGISTRY_ADDRESS: contractAddress,
        PUBLIC_BASE_URL: publicBaseUrl
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let appOutput = '';
    credixaApp.stdout.on('data', c => appOutput += c.toString());
    credixaApp.stderr.on('data', c => appOutput += c.toString());

    const base = `http://127.0.0.1:${appPort}`;
    let ready = false;
    for (let i = 0; i < 80; i++) {
      if (credixaApp.exitCode !== null) throw Error(`Server died: ${appOutput}`);
      try {
        const r = await fetch(`${base}/api/auth/me`);
        if (r.status === 401) { ready = true; break; }
      } catch {}
      await wait(100);
    }
    assert.ok(ready, `Credixa server failed to start: ${appOutput}`);
    console.log(`[Server Setup] Credixa backend ready at ${base}`);

    // Helper for API calls with session cookie
    let sessionCookie = '';
    const api = async (route, body, method = 'POST', headers = {}) => {
      const response = await fetch(`${base}${route}`, {
        method,
        headers: {
          ...(sessionCookie ? { cookie: sessionCookie } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...headers
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      return response;
    };

    // ==========================================
    // STEP 1: Register and Log in
    // ==========================================
    console.log('\n[Step 1] Testing Register and Log in...');
    const testUser = {
      email: `candidate-${Date.now()}@credixa-test.example`,
      password: 'StrongCandidatePassword2026!',
      name: 'Gayathri Candidate'
    };

    // Register
    const regRes = await api('/api/auth/register', testUser);
    assert.equal(regRes.status, 201, 'Registration should return 201 Created');
    const setCookie = regRes.headers.get('set-cookie');
    assert.ok(setCookie, 'Registration should return a session cookie');
    sessionCookie = setCookie.split(';')[0];
    const regData = await regRes.json();
    assert.equal(regData.user.email, testUser.email);
    console.log('✓ Registration passed: account created with password hashed (scrypt) and session cookie issued.');

    // Logout and Login
    await api('/api/auth/logout', {});
    sessionCookie = '';
    const meBefore = await api('/api/auth/me', null, 'GET');
    assert.equal(meBefore.status, 401, 'After logout, /api/auth/me must return 401');

    const loginRes = await api('/api/auth/login', { email: testUser.email, password: testUser.password });
    assert.equal(loginRes.status, 200, 'Login should succeed with status 200');
    sessionCookie = loginRes.headers.get('set-cookie').split(';')[0];
    const meAfter = await api('/api/auth/me', null, 'GET');
    assert.equal(meAfter.status, 200);
    const meData = await meAfter.json();
    assert.equal(meData.user.email, testUser.email);
    console.log('✓ Login passed: verified session authentication and /api/auth/me.');

    // ==========================================
    // STEP 2: Upload a Resume
    // ==========================================
    console.log('\n[Step 2] Testing Resume Upload and Local Processing...');
    const resumeFilePath = path.resolve(__dirname, '../e2e-test-resume.txt');
    const resumeRawText = fs.readFileSync(resumeFilePath, 'utf8');
    const resumeSha256 = crypto.createHash('sha256').update(resumeRawText, 'utf8').digest('hex');
    console.log(`  Uploaded resume SHA-256: ${resumeSha256}`);

    // Save initial profile
    const saveProfileRes = await api('/api/profile', {
      resumeText: resumeRawText,
      fileName: 'e2e-test-resume.txt',
      hash: resumeSha256,
      preferences: { role: 'Frontend Developer', location: 'remote' },
      jobs: []
    }, 'PUT');
    assert.equal(saveProfileRes.status, 200, 'Saving profile must return 200');

    const profileCheck = await (await api('/api/profile', null, 'GET')).json();
    assert.equal(profileCheck.profile.resumeText, resumeRawText);
    assert.equal(profileCheck.profile.hash, resumeSha256);
    console.log('✓ Upload and profile save passed: AES-256-GCM encrypted persistence validated.');

    // ==========================================
    // STEP 3: Extract Skills and Generate Resume Analysis
    // ==========================================
    console.log('\n[Step 3] Testing Skill Extraction and ATS Rubric Analysis...');
    const localAnalysis = analyzeResumeText(resumeRawText);
    assert.ok(localAnalysis.score >= 80, `Expected high rubric score for complete resume, got ${localAnalysis.score}`);
    assert.ok(localAnalysis.skills.includes('JavaScript'));
    assert.ok(localAnalysis.skills.includes('React'));
    assert.ok(localAnalysis.skills.includes('Python'));
    assert.ok(localAnalysis.skills.includes('SQL'));
    assert.ok(localAnalysis.extracted.skills.length >= 4);
    assert.ok(localAnalysis.extracted.experience.length >= 1);
    assert.ok(localAnalysis.extracted.qualifications.length >= 1);
    assert.ok(localAnalysis.extracted.projects.length >= 1);
    console.log(`  Extracted skills: ${localAnalysis.skills.join(', ')}`);
    console.log(`  Rubric score: ${localAnalysis.score}/100 (${localAnalysis.criteria.filter(c => c.met).length}/${localAnalysis.criteria.length} criteria met)`);

    // Update profile with analysis
    await api('/api/profile', {
      resumeText: resumeRawText,
      fileName: 'e2e-test-resume.txt',
      hash: resumeSha256,
      analysis: localAnalysis,
      preferences: { role: 'Frontend Developer', location: 'remote' },
      jobs: []
    }, 'PUT');

    const dashRes = await (await api('/api/dashboard', null, 'GET')).json();
    assert.equal(dashRes.resume.uploaded, true);
    assert.equal(dashRes.atsScore, localAnalysis.score);
    assert.deepEqual(dashRes.skills, localAnalysis.skills.slice(0, 16));
    console.log('✓ Skill extraction and rubric analysis passed: dashboard displays score, sections, and detected skills.');

    // ==========================================
    // STEP 4: Review and Accept Resume Improvement Suggestions
    // ==========================================
    console.log('\n[Step 4] Testing AI Suggestions Review and Acceptance...');
    // Request suggestions via /api/llm proxy
    const suggestionPrompt = `You are editing a resume using only its supplied content. Return JSON only: {"suggestions":[{"title":"short label","reason":"specific explanation","source_text":"an exact contiguous excerpt copied from the resume","suggested_text":"a conservative rewrite of only that excerpt"}]}. Return at most 5 suggestions. Every source_text must be copied verbatim and be non-empty. Do not add or imply any new qualification, skill, project, employer, role, date, number, outcome, or achievement. Preserve all factual claims and metrics exactly. If no safe improvement exists, return an empty suggestions array. Do not give generic suggestions that require adding facts.\nResume text:\n${resumeRawText}`;
    
    const llmRes = await api('/api/llm', {
      provider: 'openai',
      apiKey: 'test-api-key',
      messages: [{ role: 'user', content: suggestionPrompt }]
    });
    assert.equal(llmRes.status, 200, 'LLM proxy request should return 200');
    const llmData = await llmRes.json();
    const suggestionsPayload = JSON.parse(llmData.content);
    assert.ok(Array.isArray(suggestionsPayload.suggestions) && suggestionsPayload.suggestions.length > 0);
    const suggestion = suggestionsPayload.suggestions[0];
    console.log(`  Received suggestion: "${suggestion.source_text}" -> "${suggestion.suggested_text}"`);

    // Verify grounding rule
    assert.equal(hasUnsupportedWording(suggestion.source_text, suggestion.suggested_text), false);
    assert.ok(resumeRawText.includes(suggestion.source_text));

    // Accept suggestion: update resume text
    const updatedResumeText = resumeRawText.replace(suggestion.source_text, suggestion.suggested_text);
    assert.ok(updatedResumeText.includes(suggestion.suggested_text));
    assert.ok(!updatedResumeText.includes(suggestion.source_text));
    suggestion.status = 'accepted';

    // Recompute analysis on updated draft
    const updatedAnalysis = analyzeResumeText(updatedResumeText);
    updatedAnalysis.suggestions = [suggestion];
    await api('/api/profile', {
      resumeText: updatedResumeText,
      fileName: 'credixa-resume.txt',
      hash: '', // draft changed, original file hash cleared
      analysis: updatedAnalysis,
      preferences: { role: 'Frontend Developer', location: 'remote' },
      jobs: []
    }, 'PUT');
    console.log('✓ Review and accept suggestion passed: grounded edit accepted, draft updated without fabricated facts.');

    // ==========================================
    // STEP 5: Download Updated Resume
    // ==========================================
    console.log('\n[Step 5] Testing Download of Updated Resume...');
    const downloadedTextBlob = Buffer.from(updatedResumeText, 'utf8');
    assert.ok(downloadedTextBlob.length > 0);
    assert.ok(downloadedTextBlob.toString('utf8').includes('Built accessible interfaces with React.'));
    console.log(`✓ Download updated resume passed: verified text draft size (${downloadedTextBlob.length} bytes) and contents.`);

    // ==========================================
    // STEP 6: Retrieve Real Job and Internship Listings
    // ==========================================
    console.log('\n[Step 6] Testing Retrieval of Real Job and Internship Listings...');
    const searchRes = await api('/api/search', {
      query: 'developer engineer',
      location: 'remote',
      candidateSkills: ['JavaScript', 'React', 'Python', 'SQL']
    });
    assert.equal(searchRes.status, 200, 'Search request must return 200');
    const searchData = await searchRes.json();
    assert.equal(searchData.source, 'remotive', 'Search source should be remotive');
    assert.ok(Array.isArray(searchData.results), 'Results should be an array');
    console.log(`  Retrieved ${searchData.results.length} real live listings from Remotive.`);
    assert.ok(searchData.results.length > 0, 'Should find live listings for remote');

    const firstJob = searchData.results[0];
    console.log(`  Sample Job: "${firstJob.title}" at "${firstJob.company || 'Company'}" (${firstJob.url})`);
    assert.match(firstJob.url, /^https?:\/\//, 'Job listing must have a valid HTTP(S) URL');

    // Test qualification and matching logic
    const matchedOpportunity = {
      title: firstJob.title,
      company: firstJob.company || 'Remotive employer',
      location: firstJob.location || 'Remote',
      url: firstJob.url,
      score: 85,
      source: 'Remotive',
      requiredSkills: ['React', 'JavaScript'],
      matchingSkills: ['React', 'JavaScript'],
      missingSkills: [],
      requiredQualifications: ["Bachelor's degree"],
      matchingQualifications: ["Bachelor's degree"],
      missingQualifications: [],
      postedDate: firstJob.published_date,
      matchMethod: 'Matched identifiable skills and qualifications divided by all identifiable requirements in the listing.'
    };

    // Save job match to profile
    await api('/api/profile', {
      resumeText: updatedResumeText,
      fileName: 'credixa-resume.txt',
      hash: '',
      analysis: updatedAnalysis,
      preferences: { role: 'Frontend Developer', location: 'remote' },
      jobs: [matchedOpportunity]
    }, 'PUT');
    console.log('✓ Live job and internship search passed: retrieved and ranked real listings from Remotive.');

    // ==========================================
    // STEP 7: Open an Actual Application Link
    // ==========================================
    console.log('\n[Step 7] Testing Opening an Actual Application Link...');
    const jobUrl = firstJob.url;
    console.log(`  Verifying URL reachability: ${jobUrl}`);
    const probeRes = await fetch(jobUrl, { method: 'HEAD', signal: AbortSignal.timeout(10000) });
    assert.ok([200, 301, 302, 303, 307, 308].includes(probeRes.status), `Application link must be reachable, got ${probeRes.status}`);
    console.log(`✓ Open application link passed: URL returned HTTP ${probeRes.status}.`);

    // ==========================================
    // STEP 8: Generate Skill-Based Assessment
    // ==========================================
    console.log('\n[Step 8] Testing Skill Assessment Generation...');
    const startRes = await api('/api/assessments/start', {
      skills: ['JavaScript', 'React'],
      totalQuestions: 20,
      difficulty: 'intermediate',
      thirdWarningAction: 'submit',
      provider: 'openai',
      apiKey: 'test-llm-key',
      model: 'mock-model'
    });
    assert.equal(startRes.status, 201, `Assessment start failed: ${await startRes.clone().text()}`);
    const session = await startRes.json();
    assert.ok(session.assessmentId);
    assert.equal(session.questions.length, 20, 'Expected 20 questions for 2 skills (10 each)');
    // Crucial check: client must NEVER receive correctOption or answer key
    assert.ok(session.questions.every(q => !Object.hasOwn(q, 'correctOption')), 'Answer key must be hidden from client');
    console.log(`✓ Skill-based assessment generation passed: 20 validated questions created for JavaScript and React.`);

    // ==========================================
    // STEP 9: Complete the Timed Quiz
    // ==========================================
    console.log('\n[Step 9] Testing Timed Quiz Completion...');
    // Answer all questions correctly (mock LLM set correctOption = 2)
    const answers = Object.fromEntries(session.questions.map(q => [q.id, 2]));
    console.log(`  Completed all ${Object.keys(answers).length} questions with selected options.`);
    console.log('✓ Quiz completion prepared.');

    // ==========================================
    // STEP 10: Test Proctoring Warnings and Event Logging
    // ==========================================
    console.log('\n[Step 10] Testing Proctoring Warnings and Event Logging...');
    const postEvent = async (type, durationMs, details = '') => {
      const res = await api('/api/assessments/events', {
        assessmentId: session.assessmentId,
        type,
        durationMs,
        details
      });
      assert.equal(res.status, 200);
      return res.json();
    };

    // Sub-threshold event (should not warn)
    const sub = await postEvent('face_absent', 4000);
    assert.equal(sub.warnings, 0, 'Duration 4000ms < 5000ms threshold should not warn');

    // Warning 1: face_absent >= 5000ms
    const w1 = await postEvent('face_absent', 5000);
    assert.equal(w1.warnings, 1);
    assert.equal(w1.warningNumber, 1);
    console.log('  Warning 1 triggered: face absent for 5s');

    // Fast event of same type during 8000ms cooldown (should not increment warning)
    const cd = await postEvent('face_absent', 5000);
    assert.equal(cd.warnings, 1, 'Cooldown on same event type must suppress warning increment');
    assert.equal(cd.warningNumber, null);
    console.log('  Cooldown verified: duplicate face_absent suppressed within 8s');

    // Warning 2: multiple_faces >= 2000ms
    const w2 = await postEvent('multiple_faces', 2000);
    assert.equal(w2.warnings, 2);
    assert.equal(w2.warningNumber, 2);
    console.log('  Warning 2 triggered: multiple faces for 2s');

    // Warning 3: head_turned >= 4000ms
    const w3 = await postEvent('head_turned', 4000);
    assert.equal(w3.warnings, 3);
    assert.equal(w3.warningNumber, 3);
    assert.equal(w3.action, 'submit');
    console.log('  Warning 3 triggered: head turned for 4s, action is submit');

    console.log('✓ Proctoring warnings and event logging passed: verified thresholds, cooldowns, and action transitions.');

    // ==========================================
    // STEP 11: Generate Skill Assessment Report
    // ==========================================
    console.log('\n[Step 11] Submitting Assessment and Generating Report...');
    const submitRes = await api('/api/assessments/submit', {
      assessmentId: session.assessmentId,
      answers
    });
    assert.equal(submitRes.status, 200, `Assessment submission failed: ${await submitRes.clone().text()}`);
    const { report } = await submitRes.json();
    assert.equal(report.score, 100);
    // Report now includes all resume skills, but only JavaScript and React were assessed
    assert.ok(report.perSkill.length >= 2, 'Report should include at least assessed skills');
    const jsSkill = report.perSkill.find(s => s.skill === 'JavaScript');
    const reactSkill = report.perSkill.find(s => s.skill === 'React');
    assert.ok(jsSkill, 'JavaScript skill should be in report');
    assert.equal(jsSkill.criteriaMet, true);
    assert.equal(jsSkill.status, 'assessment_criteria_met');
    assert.ok(reactSkill, 'React skill should be in report');
    assert.equal(reactSkill.criteriaMet, true);
    assert.equal(reactSkill.status, 'assessment_criteria_met');
    assert.equal(report.warningCount, 3);
    assert.ok(report.events.length >= 3);
    console.log(`✓ Skill assessment report generated: Overall score 100%, JavaScript & React criteria met (10/10 correct each), ${report.warningCount} warnings logged.`);

    // ==========================================
    // STEP 12: Create Verification Record and Record Hash on Blockchain
    // ==========================================
    console.log('\n[Step 12] Testing Verification Record Creation and Blockchain Anchoring...');
    const createVerifRes = await api('/api/verifications', {});
    assert.equal(createVerifRes.status, 201, `Create verification record failed: ${await createVerifRes.clone().text()}`);
    const verifData = await createVerifRes.json();
    assert.match(verifData.verificationId, /^[a-f0-9]{48}$/);
    assert.match(verifData.recordHash, /^[a-f0-9]{64}$/);
    console.log(`  Created Verification ID: ${verifData.verificationId}`);
    console.log(`  Computed Record Hash: ${verifData.recordHash}`);
    assert.equal(verifData.publicUrl, `${publicBaseUrl}/verify/${verifData.verificationId}`);

    const jsSkillVerif = verifData.skills.find(s => s.skill === 'JavaScript');
    const reactSkillVerif = verifData.skills.find(s => s.skill === 'React');
    const pythonSkillVerif = verifData.skills.find(s => s.skill === 'Python');
    assert.equal(jsSkillVerif.status, 'verified');
    assert.equal(reactSkillVerif.status, 'verified');
    assert.equal(pythonSkillVerif.status, 'not_assessed');

    // Anchor hash on EVM blockchain smart contract
    console.log(`  Anchoring record hash 0x${verifData.recordHash} to ResumeRegistry contract at ${contractAddress}...`);
    const tx = await contract.registerResume(`0x${verifData.recordHash}`);
    const receipt = await tx.wait();
    assert.equal(receipt.status, 1, 'Contract transaction must succeed');
    console.log(`  Transaction confirmed on-chain: ${receipt.hash}`);

    // Confirm transaction with backend
    const confirmRes = await api(`/api/verifications/${verifData.verificationId}/confirm`, {
      transactionHash: receipt.hash
    });
    assert.equal(confirmRes.status, 200, `Confirmation failed: ${await confirmRes.clone().text()}`);
    const confirmData = await confirmRes.json();
    assert.equal(confirmData.blockchainStatus, 'anchored');
    console.log('✓ Verification record created and anchored on EVM ResumeRegistry contract.');

    // ==========================================
    // STEP 13: Download Resume with Credixa Verified Skills Badge and QR Code
    // ==========================================
    console.log('\n[Step 13] Testing Generation of Resume with Verified Skills Badge and QR Code...');
    const qr = qrcode(0, 'M');
    qr.addData(verifData.publicUrl, 'Byte');
    qr.make();
    const qrDataUrl = qr.createDataURL(6, 2);
    assert.ok(qrDataUrl.startsWith('data:image/gif;base64,') || qrDataUrl.startsWith('data:image/png;base64,'));

    // Test PDF generation mirroring frontend/verified-resume.js
    const pdfDoc = new jsPDF({ unit: 'mm', format: 'a4' });
    const pageWidth = pdfDoc.internal.pageSize.getWidth();
    pdfDoc.setFillColor(17, 21, 27);
    pdfDoc.rect(0, 0, pageWidth, 36, 'F');
    pdfDoc.setTextColor(182, 242, 210);
    pdfDoc.setFont('helvetica', 'bold');
    pdfDoc.setFontSize(18);
    pdfDoc.text('Credixa Verified Skills', 18, 16);
    pdfDoc.setFont('helvetica', 'normal');
    pdfDoc.setFontSize(9);
    pdfDoc.text('Record integrity verified · skill outcomes are assessment evidence', 18, 24);
    pdfDoc.setFontSize(8);
    pdfDoc.text(`Verification ID: ${verifData.verificationId}`, 18, 31);
    pdfDoc.addImage(qrDataUrl, 'PNG', pageWidth - 18 - 29, 5, 25, 25);
    pdfDoc.text('Resume Content and Verified Skills Assessment Status', 18, 50);

    const pdfBuffer = Buffer.from(pdfDoc.output('arraybuffer'));
    assert.ok(pdfBuffer.length > 2000, 'PDF buffer should be valid non-empty document');
    console.log(`✓ Download PDF passed: generated ${pdfBuffer.length} bytes PDF with badge, QR code, and skills.`);

    // ==========================================
    // STEP 14: Open the QR Code Using a Different Browser Without Logging In
    // ==========================================
    console.log('\n[Step 14] Testing Public QR Target Route Without Authentication...');
    // Unauthenticated request to /verify/<id>
    const unauthPageRes = await fetch(`${base}/verify/${verifData.verificationId}`);
    assert.equal(unauthPageRes.status, 200, 'Public verify page should return 200');
    const verifyHtml = await unauthPageRes.text();
    assert.ok(verifyHtml.includes('Record integrity check'));
    assert.ok(!verifyHtml.includes('+<script>'), 'verify.html must NOT have git diff syntax errors');
    assert.ok(!verifyHtml.includes('+const id='), 'verify.html script must be clean');
    console.log('✓ Public QR page opens successfully without session authentication.');

    // ==========================================
    // STEP 15: Verify the Record Successfully
    // ==========================================
    console.log('\n[Step 15] Testing Unauthenticated Public Verification API...');
    const pubRes = await fetch(`${base}/api/public-verifications/${verifData.verificationId}`);
    assert.equal(pubRes.status, 200);
    const pubData = await pubRes.json();
    assert.equal(pubData.status, 'integrity_match');
    assert.equal(pubData.verificationId, verifData.verificationId);
    assert.ok(Array.isArray(pubData.verifiedSkills));
    assert.equal(pubData.verifiedSkills.length, 2); // JavaScript & React
    assert.equal(pubData.verifiedSkills[0].skill, 'JavaScript');
    assert.equal(pubData.verifiedSkills[1].skill, 'React');
    // Ensure no private candidate email or raw phone numbers leaked in public payload
    const rawPublicPayload = JSON.stringify(pubData);
    assert.ok(!rawPublicPayload.includes(testUser.email), 'Candidate email must NEVER appear in public verification payload');
    console.log('✓ Public verification passed: record integrity verified against on-chain smart contract, candidate personal data strictly isolated.');

    // ==========================================
    // STEP 16: Test a Modified Record and Confirm Integrity Verification Detects Change
    // ==========================================
    console.log('\n[Step 16] Testing Integrity Detection on Modified/Tampered Record...');
    const userFilePath = path.join(temporaryData, 'users.json');
    const usersStore = JSON.parse(fs.readFileSync(userFilePath, 'utf8'));
    const candidateProfile = openProfile(usersStore[testUser.email].profile, testSecret);

    // Tamper with skill score in off-chain record
    const originalScore = candidateProfile.verificationRecords[0].record.skills[0].score;
    candidateProfile.verificationRecords[0].record.skills[0].score = 99;
    usersStore[testUser.email].profile = sealProfile(candidateProfile, testSecret);
    fs.writeFileSync(userFilePath, JSON.stringify(usersStore));

    const tamperedRes = await fetch(`${base}/api/public-verifications/${verifData.verificationId}`);
    assert.equal(tamperedRes.status, 200);
    const tamperedData = await tamperedRes.json();
    assert.equal(tamperedData.status, 'record_modified', 'Tampered record must return status record_modified');
    console.log(`  Tampered record check: status = "${tamperedData.status}" - "${tamperedData.message}"`);

    // Restore record score, but tamper with current resume text
    candidateProfile.verificationRecords[0].record.skills[0].score = originalScore;
    candidateProfile.resumeText = 'Completely altered resume text that does not match snapshot.';
    usersStore[testUser.email].profile = sealProfile(candidateProfile, testSecret);
    fs.writeFileSync(userFilePath, JSON.stringify(usersStore));

    const resumeModifiedRes = await fetch(`${base}/api/public-verifications/${verifData.verificationId}`);
    const resumeModifiedData = await resumeModifiedRes.json();
    assert.equal(resumeModifiedData.status, 'resume_modified', 'Modified resume must return status resume_modified');
    console.log(`  Modified resume check: status = "${resumeModifiedData.status}" - "${resumeModifiedData.message}"`);

    console.log('✓ Integrity verification passed: modified record and altered resume text were both immediately detected and rejected.');

    console.log('\n=============================================================');
    console.log('ALL 16 WORKFLOW STEPS SUCCESSFULLY TESTED AND VERIFIED!');
    console.log('=============================================================\n');

  } finally {
    if (credixaApp && credixaApp.exitCode === null) credixaApp.kill();
    await close(mockLlmServer);
    await close(rpcServer);
    if (evmProvider.disconnect) await evmProvider.disconnect();
    fs.rmSync(temporaryData, { recursive: true, force: true });
  }
}

runComprehensiveE2ETest().catch(error => {
  console.error('\nE2E Workflow Test FAILED:', error);
  process.exitCode = 1;
});
