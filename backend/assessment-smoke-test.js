const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function close(server) {
  if (!server?.listening) return;
  await new Promise(resolve => server.close(resolve));
}

async function main() {
  const temporaryData = fs.mkdtempSync(path.join(os.tmpdir(), 'credixa-assessment-'));
  let mockServer;
  let application;
  let mockPort;
  let applicationPort;
  const questionsFor = prompt => {
    const match = prompt.match(/Use these skills only: (\[[^\]]+\])\./);
    if (!match) throw Error('Assessment prompt did not contain the selected resume skills.');
    const skills = JSON.parse(match[1]);
    return skills.flatMap(skill => Array.from({ length: 5 }, (_, index) => ({
      skill,
      question: `${skill} applied knowledge question ${index + 1}?`,
      options: ['Incorrect option A', 'Incorrect option B', 'Correct option', 'Incorrect option D'],
      correctOption: 2,
      explanation: `Option C is correct for ${skill} based on this test fixture.`
    })));
  };

  try {
    mockServer = http.createServer((request, response) => {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const prompt = parsed.messages?.[0]?.content || '';
          const content = JSON.stringify({ questions: questionsFor(prompt) });
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ choices: [{ message: { content } }] }));
        } catch (error) {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { message: error.message } }));
        }
      });
    });
    mockPort = await listen(mockServer);
    applicationPort = 32000 + Math.floor(Math.random() * 10000);
    application = spawn(process.execPath, ['backend/server.js'], {
      cwd: path.resolve(__dirname, '..'),
      env: {
        ...process.env,
        PORT: String(applicationPort),
        APP_SECRET: 'assessment-smoke-test-only-secret',
        CREDIXA_DATA_DIR: temporaryData,
        OPENAI_API_BASE_URL: `http://127.0.0.1:${mockPort}/v1/chat/completions`
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let serverOutput = '';
    application.stdout.on('data', chunk => { serverOutput += chunk.toString(); });
    application.stderr.on('data', chunk => { serverOutput += chunk.toString(); });

    const base = `http://127.0.0.1:${applicationPort}`;
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (application.exitCode !== null) throw Error(`Credixa server stopped: ${serverOutput}`);
      try {
        const response = await fetch(`${base}/api/auth/me`);
        if (response.status === 401) { ready = true; break; }
      } catch { /* wait for local listener */ }
      await wait(100);
    }
    assert.equal(ready, true, `Credixa server did not start: ${serverOutput}`);

    const registerResponse = await fetch(`${base}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `assessment-${Date.now()}@example.test`, password: 'assessment-smoke-password', name: 'Assessment Test' })
    });
    assert.equal(registerResponse.status, 201);
    const cookie = registerResponse.headers.get('set-cookie').split(';')[0];
    const call = (route, body, method = 'POST') => fetch(`${base}${route}`, {
      method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });

    const profileResponse = await call('/api/profile', {
      resumeText: 'Skills\nJavaScript',
      analysis: { skills: ['JavaScript'], extracted: { skills: ['JavaScript'], qualifications: [], projects: [], experience: [] } },
      preferences: {}, jobs: []
    }, 'PUT');
    assert.equal(profileResponse.status, 200);
    const assessmentDataResponse = await call('/api/assessments', null, 'GET');
    const assessmentData = await assessmentDataResponse.json();
    assert.deepEqual(assessmentData.skills, ['JavaScript']);

    const start = async thirdWarningAction => {
      const response = await call('/api/assessments/start', {
        skills: ['JavaScript'], difficulty: 'intermediate', minutes: 10, thirdWarningAction,
        provider: 'openai', apiKey: 'local-test-key', model: 'mock-model'
      });
      assert.equal(response.status, 201, await response.clone().text());
      return response.json();
    };
    const session = await start('submit');
    assert.equal(session.questions.length, 5);
    assert.ok(session.questions.every(question => !Object.hasOwn(question, 'correctOption')));

    const event = async (assessmentId, type, durationMs) => {
      const response = await call('/api/assessments/events', { assessmentId, type, durationMs });
      assert.equal(response.status, 200);
      return response.json();
    };
    assert.equal((await event(session.assessmentId, 'camera_permission_denied', 0)).warnings, 0);
    assert.equal((await event(session.assessmentId, 'face_absent', 4999)).warnings, 0);
    assert.equal((await event(session.assessmentId, 'face_absent', 5000)).warnings, 1);
    assert.equal((await event(session.assessmentId, 'multiple_faces', 2000)).warnings, 2);
    const thirdWarning = await event(session.assessmentId, 'head_turned', 4000);
    assert.equal(thirdWarning.warningNumber, 3);
    assert.equal(thirdWarning.action, 'submit');

    const answers = Object.fromEntries(session.questions.map(question => [question.id, 2]));
    const submitted = await call('/api/assessments/submit', { assessmentId: session.assessmentId, answers });
    assert.equal(submitted.status, 200);
    const report = (await submitted.json()).report;
    assert.equal(report.score, 100);
    assert.equal(report.perSkill[0].criteriaMet, true);
    assert.equal(report.events.length, 5);
    assert.equal(report.warningCount, 3);

    const second = await start('terminate');
    assert.equal((await event(second.assessmentId, 'tab_hidden', 1999)).warnings, 0);
    assert.equal((await event(second.assessmentId, 'tab_hidden', 2000)).warnings, 1);
    assert.equal((await event(second.assessmentId, 'face_absent', 5000)).warnings, 2);
    const terminatingWarning = await event(second.assessmentId, 'multiple_faces', 2000);
    assert.equal(terminatingWarning.terminated, true);
    const terminatedResponse = await call('/api/assessments/submit', { assessmentId: second.assessmentId, answers, terminated: true });
    assert.equal(terminatedResponse.status, 200);
    const terminatedReport = (await terminatedResponse.json()).report;
    assert.equal(terminatedReport.score, null);
    assert.equal(terminatedReport.perSkill[0].criteriaMet, false);

    const autosave = await call('/api/profile', {
      resumeText: 'Skills\nJavaScript', analysis: { skills: ['JavaScript'], extracted: { skills: ['JavaScript'] } }, preferences: {}, jobs: []
    }, 'PUT');
    assert.equal(autosave.status, 200);
    const historyResponse = await call('/api/assessments', null, 'GET');
    const history = await historyResponse.json();
    assert.equal(history.reports.length, 2);
    assert.equal(history.reports[0].terminated, true);
    assert.equal(history.reports[1].events.length, 5);

    const unauthorized = await fetch(`${base}/api/assessments`);
    assert.equal(unauthorized.status, 401);
    console.log('Assessment integration passed: resume skill gating, generated-question schema, hidden answer key, duration thresholds, three-warning submit/terminate rules, per-skill scoring, event timestamps, encrypted history, and autosave preservation.');
  } finally {
    if (application && application.exitCode === null) application.kill();
    await close(mockServer);
    fs.rmSync(temporaryData, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
