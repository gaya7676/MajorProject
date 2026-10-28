const assessmentState = {
  skills: [],
  session: null,
  answers: {},
  index: 0,
  secondsLeft: 0,
  timer: null,
  stream: null,
  faceDetector: null,
  cameraFrame: null,
  monitorTimer: null,
  visibilityTimer: null,
  hiddenAt: null,
  monitorState: null,
  events: [],
  warnings: 0,
  stopped: false,
  busy: false
};

const assessment$ = id => document.getElementById(id);
const assessmentEsc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
async function loadAssessmentData() {
  try {
    const response = await fetch('/api/assessments');
    const data = await response.json();
    if (!response.ok) throw Error(data.error || 'Could not load assessment data.');
    assessmentState.skills = data.skills || [];
    renderAssessmentSkills();
    renderAssessmentHistory(data.reports || []);
    renderProctoringEvents(data.proctoringEvents || []);
  } catch (error) {
    assessment$('assessmentSetupStatus').textContent = error.message;
    assessment$('assessmentSetupStatus').classList.add('error');
  }
}

function renderAssessmentSkills() {
  const target = assessment$('assessmentSkills');
  if (!assessmentState.skills.length) {
    target.innerHTML = '<p class="note">No analyzed resume skills found. Upload and analyze your resume first.</p>';
    assessment$('startAssessmentBtn').disabled = true;
    return;
  }
  target.innerHTML = `<span class="label">Choose up to 3 skills from your analyzed resume</span><div class="assessment-skill-options">${assessmentState.skills.map((skill, index) => `<label class="assessment-skill"><input type="checkbox" value="${assessmentEsc(skill)}" ${index < 3 ? 'checked' : ''}><span>${assessmentEsc(skill)}</span></label>`).join('')}</div>`;
  assessment$('startAssessmentBtn').disabled = false;
  target.addEventListener('change', event => {
    if (event.target.matches('input[type="checkbox"]')) {
      const checked = [...target.querySelectorAll('input:checked')];
      if (checked.length > 3) event.target.checked = false;
      assessment$('startAssessmentBtn').disabled = target.querySelectorAll('input:checked').length === 0;
    }
  });
}

function renderAssessmentHistory(reports) {
  const target = assessment$('assessmentHistory');
  if (!reports.length) {
    target.innerHTML = '<p class="note">No assessment reports yet.</p>';
    return;
  }
  target.innerHTML = reports.map(report => `<article class="assessment-report-row"><div><strong>${assessmentEsc(report.skills?.join(', ') || 'Skills assessment')}</strong><span>${assessmentEsc(report.difficulty)} · ${new Date(report.completedAt).toLocaleString()}</span></div><b>${report.terminated ? 'Not scored' : `${assessmentEsc(report.score)}% overall`}</b><button type="button" class="btn small" data-report-id="${assessmentEsc(report.id)}">View report</button></article>`).join('');
  target.onclick = event => {
    const button = event.target.closest('[data-report-id]');
    if (!button) return;
    const report = reports.find(item => item.id === button.dataset.reportId);
    if (report) renderAssessmentReport(report, false);
  };
}

function renderProctoringEvents(events) {
  let details = assessment$('assessmentEventHistory');
  if (!details) {
    details = document.createElement('details');
    details.id = 'assessmentEventHistory';
    details.className = 'assessment-events-history';
    details.innerHTML = '<summary>Recent monitoring signals</summary><div class="assessment-event-list"></div>';
    assessment$('assessmentHistory').after(details);
  }
  const list = details.querySelector('.assessment-event-list');
  list.innerHTML = events.length ? `<ul>${events.map(event => `<li>${assessmentEsc(event.createdAt)} · ${assessmentEsc(event.type)}${event.warningNumber ? ` · Warning ${assessmentEsc(event.warningNumber)}` : ''}${event.durationMs ? ` · ${Math.round(event.durationMs / 1000)}s` : ''}</li>`).join('')}</ul>` : '<p class="note">No monitoring signals recorded.</p>';
}

async function startAssessment() {
  const skills = [...assessment$('assessmentSkills').querySelectorAll('input:checked')].map(input => input.value);
  if (!skills.length || skills.length > 3) {
    assessment$('assessmentSetupStatus').textContent = 'Choose one to three skills from the analyzed resume.';
    assessment$('assessmentSetupStatus').className = 'status error';
    return;
  }
  // API key is optional - backend will use environment variables if not provided
  const button = assessment$('startAssessmentBtn');
  button.disabled = true;
  assessment$('assessmentSetupStatus').textContent = 'Generating and validating questions for the selected resume skills…';
  assessment$('assessmentSetupStatus').className = 'status';
  try {
    const response = await fetch('/api/assessments/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        skills,
        difficulty: assessment$('assessmentDifficulty').value,
        minutes: Number(assessment$('assessmentMinutes').value),
        thirdWarningAction: assessment$('thirdWarningAction').value,
        provider: conf.provider,
        apiKey: conf.llmKey,
        model: conf.model
      })
    });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || 'Question generation failed.');
    assessmentState.session = data;
    assessmentState.answers = {};
    assessmentState.events = [];
    assessmentState.warnings = 0;
    assessmentState.index = 0;
    assessmentState.secondsLeft = data.minutes * 60;
    assessmentState.stopped = false;
    assessment$('assessmentSetup').classList.add('hide');
    assessment$('assessmentResults').classList.add('hide');
    assessment$('assessmentActive').classList.remove('hide');
    renderAssessmentQuestion();
    startAssessmentClock();
    await startCameraMonitoring();
  } catch (error) {
    assessment$('assessmentSetupStatus').textContent = error.message || 'Could not start assessment. Check your LLM connection and try again.';
    assessment$('assessmentSetupStatus').className = 'status error';
  } finally {
    button.disabled = false;
  }
}

function renderAssessmentQuestion() {
  const questions = assessmentState.session.questions;
  const question = questions[assessmentState.index];
  assessment$('assessmentProgress').textContent = `Question ${assessmentState.index + 1} of ${questions.length} · ${question.skill}`;
  assessment$('questionArea').innerHTML = `<div class="assessment-question"><h3>${assessmentEsc(question.question)}</h3><fieldset><legend>Select one answer</legend>${question.options.map((option, index) => `<label class="assessment-option"><input type="radio" name="answer" value="${index}" ${assessmentState.answers[question.id] === index ? 'checked' : ''}><span>${assessmentEsc(option)}</span></label>`).join('')}</fieldset></div>`;
  assessment$('questionArea').onchange = event => {
    if (event.target.matches('input[type="radio"]')) assessmentState.answers[question.id] = Number(event.target.value);
  };
  assessment$('previousQuestionBtn').disabled = assessmentState.index === 0;
  assessment$('nextQuestionBtn').disabled = assessmentState.index === questions.length - 1;
}

function startAssessmentClock() {
  clearInterval(assessmentState.timer);
  updateAssessmentClock();
  assessmentState.timer = setInterval(() => {
    assessmentState.secondsLeft -= 1;
    updateAssessmentClock();
    if (assessmentState.secondsLeft <= 0) submitAssessment(false, true);
  }, 1000);
}

function updateAssessmentClock() {
  const minutes = Math.floor(Math.max(0, assessmentState.secondsLeft) / 60);
  const seconds = Math.max(0, assessmentState.secondsLeft) % 60;
  assessment$('assessmentTimer').textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

async function postProctorEvent(type, durationMs = 0, details = '') {
  if (!assessmentState.session || assessmentState.stopped) return { warnings: assessmentState.warnings };
  const event = { type, durationMs, details, timestamp: new Date().toISOString() };
  assessmentState.events.push(event);
  try {
    const response = await fetch('/api/assessments/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assessmentId: assessmentState.session.assessmentId, type, durationMs, details })
    });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || 'Could not save monitoring event.');
    assessmentState.warnings = data.warnings;
    assessment$('warningCounter').textContent = `Warnings ${data.warnings}/3`;
    if (data.warningNumber) {
      assessment$('warningNotice').textContent = `Warning ${data.warningNumber}: ${eventDescription(type)}. This is a monitoring signal and is not proof of misconduct.`;
      assessment$('warningNotice').classList.add('visible');
    }
    if (data.terminated) {
      assessmentState.stopped = true;
      await submitAssessment(true, false);
    } else if (data.action === 'submit') {
      await submitAssessment(false, true);
    }
    return data;
  } catch (error) {
    assessment$('assessmentStatus').textContent = `Monitoring event could not be saved: ${error.message}. Your answers remain available; submit or retry when connected.`;
    assessment$('assessmentStatus').className = 'status error';
    return { warnings: assessmentState.warnings, error: true };
  }
}

function eventDescription(type) {
  return ({ tab_hidden: 'the assessment tab became hidden', face_absent: 'no face was detected for a sustained interval', multiple_faces: 'more than one face was detected for a sustained interval', head_turned: 'head direction remained outside the configured range', camera_permission_denied: 'camera permission was denied', camera_error: 'camera monitoring failed', camera_unavailable: 'camera monitoring is unavailable', face_model_unavailable: 'face landmark monitoring is unavailable' })[type] || 'a monitoring event was recorded';
}

async function startCameraMonitoring() {
  assessmentState.stream?.getTracks().forEach(track => track.stop());
  assessmentState.stream = null;
  assessment$('cameraStatus').textContent = 'Requesting camera permission…';
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw Error('Camera access is not available in this browser context.');
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
    assessmentState.stream = stream;
    const video = assessment$('proctorVideo');
    video.srcObject = stream;
    await video.play();
    assessment$('cameraStatus').textContent = 'Camera active · analysis stays on this device';
    assessment$('proctorNotice').textContent = 'No video is uploaded or saved. Monitoring indicators can be inaccurate and are not proof of identity or cheating.';
    if (window.FaceDetector) await startNativeFaceDetection(video);
    else if (window.vision?.FaceLandmarker) await startMediaPipeDetection(video);
    else {
      assessment$('cameraStatus').textContent = 'Camera active · face analysis unavailable';
      await postProctorEvent('face_model_unavailable', 0, 'No supported local face detector is available in this browser.');
    }
  } catch (error) {
    assessmentState.stream?.getTracks().forEach(track => track.stop());
    assessmentState.stream = null;
    assessment$('proctorVideo').srcObject = null;
    const type = error.name === 'NotAllowedError' || error.name === 'SecurityError' ? 'camera_permission_denied' : 'camera_error';
    assessment$('cameraStatus').textContent = type === 'camera_permission_denied' ? 'Camera permission denied' : 'Camera unavailable';
    assessment$('proctorNotice').textContent = `${error.message || 'Camera access failed.'} Assessment can continue; camera signals will not be available.`;
    await postProctorEvent(type, 0, String(error.message || 'Camera startup failed').slice(0, 160));
  }
}

async function startNativeFaceDetection(video) {
  try {
    assessmentState.faceDetector = new FaceDetector({ fastMode: true, maxDetectedFaces: 3 });
    assessment$('proctorNotice').textContent = 'This browser can detect face count but does not expose head direction. No pose warnings are generated. Video remains on this device.';
    startDetectionLoop(async () => {
      if (video.readyState < 2) return;
      const faces = await assessmentState.faceDetector.detect(video);
      processFaceCount(faces.length);
    });
  } catch {
    if (window.vision?.FaceLandmarker) await startMediaPipeDetection(video);
    else throw Error('Browser face detection could not be initialized.');
  }
}

async function startMediaPipeDetection(video) {
  const vision = await window.vision;
  const files = await vision.FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/wasm');
  const landmarker = await vision.FaceLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task', delegate: 'CPU' },
    runningMode: 'VIDEO', numFaces: 3,
    outputFaceBlendshapes: false,
    outputFacialTransformationMatrixes: true
  });
  let lastVideoTime = -1;
  startDetectionLoop(() => {
    if (video.readyState < 2 || video.currentTime === lastVideoTime) return;
    lastVideoTime = video.currentTime;
    const result = landmarker.detectForVideo(video, performance.now());
    const faces = result.faceLandmarks || [];
    processFaceCount(faces.length);
    if (faces.length === 1 && faces[0].length > 263) processLandmarkPose(faces[0]);
  });
}

function startDetectionLoop(callback) {
  const loop = async () => {
    if (assessmentState.stopped || !assessmentState.session) return;
    try { await callback(); } catch { /* transient frame failures are ignored */ }
    assessmentState.cameraFrame = requestAnimationFrame(loop);
  };
  assessmentState.cameraFrame = requestAnimationFrame(loop);
}

function updateDurationState(key, condition, thresholdMs, type, details) {
  const current = assessmentState.monitorState?.[key];
  if (condition && !current) assessmentState.monitorState[key] = { since: performance.now(), reported: false };
  if (!condition && current) assessmentState.monitorState[key] = null;
  const state = assessmentState.monitorState?.[key];
  if (state && !state.reported && performance.now() - state.since >= thresholdMs) {
    state.reported = true;
    postProctorEvent(type, Math.round(performance.now() - state.since), details);
  }
}

function processFaceCount(count) {
  assessmentState.monitorState ||= {};
  updateDurationState('noFace', count === 0, 5000, 'face_absent', 'No face landmarks detected for at least 5 seconds.');
  updateDurationState('multiFace', count > 1, 2000, 'multiple_faces', 'More than one face detected for at least 2 seconds.');
  if (count !== 1) assessmentState.monitorState.headTurn = null;
}

function processLandmarkPose(points) {
  const left = points[33];
  const right = points[263];
  const nose = points[1];
  if (!left || !right || !nose) return;
  const eyeCenter = (left.x + right.x) / 2;
  const eyeWidth = Math.abs(right.x - left.x);
  const horizontal = eyeWidth ? (nose.x - eyeCenter) / eyeWidth : 0;
  const vertical = (nose.y - (left.y + right.y) / 2) / Math.max(eyeWidth, 0.001);
  processPose(horizontal, vertical);
}

function processPose(horizontal, vertical) {
  assessmentState.monitorState ||= {};
  const turned = Math.abs(horizontal) > 0.30 || vertical > 0.62 || vertical < -0.22;
  updateDurationState('headTurn', turned, 4000, 'head_turned', 'Estimated head direction remained outside the broad forward-facing range for at least 4 seconds.');
}

async function stopCameraMonitoring() {
  cancelAnimationFrame(assessmentState.cameraFrame);
  clearInterval(assessmentState.monitorTimer);
  assessmentState.stream?.getTracks().forEach(track => track.stop());
  assessmentState.stream = null;
  if (assessment$('proctorVideo')) assessment$('proctorVideo').srcObject = null;
}

async function submitAssessment(terminated, fromTimer) {
  if (assessmentState.busy || !assessmentState.session) return;
  assessmentState.busy = true;
  clearInterval(assessmentState.timer);
  assessment$('submitAssessmentBtn').disabled = true;
  assessment$('assessmentStatus').textContent = fromTimer ? 'Time limit reached. Submitting your answers…' : 'Submitting and scoring your assessment…';
  assessment$('assessmentStatus').className = 'status';
  await stopCameraMonitoring();
  try {
    const response = await fetch('/api/assessments/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assessmentId: assessmentState.session.assessmentId, answers: assessmentState.answers, terminated })
    });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || 'Could not submit assessment.');
    assessmentState.session = null;
    assessment$('assessmentActive').classList.add('hide');
    renderAssessmentReport(data.report, true);
    loadAssessmentData();
  } catch (error) {
    assessment$('assessmentStatus').textContent = `Submission failed: ${error.message}. Check connectivity and retry submission.`;
    assessment$('assessmentStatus').className = 'status error';
    assessment$('submitAssessmentBtn').disabled = false;
    if (!terminated && assessmentState.secondsLeft > 0) startAssessmentClock();
  } finally {
    assessmentState.busy = false;
  }
}

function renderAssessmentReport(report, showResults) {
  const target = assessment$('assessmentResults');
  target.innerHTML = `<article class="assessment-report"><div class="card-head"><div><div class="card-title">Assessment report</div><div class="card-desc">${new Date(report.completedAt).toLocaleString()} · ${assessmentEsc(report.difficulty)} · ${report.timeLimitMinutes} minute limit</div></div><span class="tag">${report.terminated ? 'NOT SCORED' : 'SCORED'}</span></div><p>${assessmentEsc(report.scoringRule)}</p>${report.terminated ? `<div class="assessment-disclosure">${assessmentEsc(report.terminationReason)}</div>` : `<div class="assessment-total">Overall: ${assessmentEsc(report.score)}% (${assessmentEsc(report.correct)}/${assessmentEsc(report.total)})</div>`}<div class="skill-report-grid">${(report.perSkill || []).map(result => `<article class="skill-report"><strong>${assessmentEsc(result.skill)}</strong><span>${result.percentage === null ? 'Not scored' : `${assessmentEsc(result.percentage)}% (${assessmentEsc(result.correct)}/${assessmentEsc(result.total)})`}</span><b class="${result.criteriaMet ? 'verified-skill' : 'not-verified-skill'}">${result.criteriaMet ? 'Assessment criteria met' : 'Not verified'}</b></article>`).join('')}</div><div class="assessment-disclosure">A skill is marked “Assessment criteria met” only when the configured threshold is reached. This is assessment evidence, not proof of identity or professional competency. Proctoring events are review signals and do not establish cheating.</div><details class="assessment-events"><summary>Monitoring events (${report.events?.length || 0})</summary>${report.events?.length ? `<ul>${report.events.map(event => `<li>${assessmentEsc(event.createdAt)} · ${assessmentEsc(event.type)}${event.warningNumber ? ` · Warning ${event.warningNumber}` : ''}${event.durationMs ? ` · ${Math.round(event.durationMs / 1000)}s` : ''}</li>`).join('')}</ul>` : '<p>No monitoring events recorded.</p>'}</details></article>`;
  target.classList.remove('hide');
  if (showResults) {
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

document.addEventListener('visibilitychange', () => {
  clearTimeout(assessmentState.visibilityTimer);
  if (document.hidden && assessmentState.session && !assessmentState.stopped) {
    assessmentState.hiddenAt = Date.now();
    assessmentState.visibilityTimer = setTimeout(() => {
      if (document.hidden && assessmentState.session && !assessmentState.stopped) postProctorEvent('tab_hidden', Date.now() - assessmentState.hiddenAt, 'Assessment page remained hidden for at least 2 seconds.');
    }, 2000);
  } else {
    assessmentState.hiddenAt = null;
  }
});

assessment$('startAssessmentBtn').addEventListener('click', startAssessment);
assessment$('previousQuestionBtn').addEventListener('click', () => {
  if (assessmentState.index > 0) { assessmentState.index -= 1; renderAssessmentQuestion(); }
});
assessment$('nextQuestionBtn').addEventListener('click', () => {
  if (assessmentState.index < assessmentState.session.questions.length - 1) { assessmentState.index += 1; renderAssessmentQuestion(); }
});
assessment$('submitAssessmentBtn').addEventListener('click', () => submitAssessment(false, false));
assessment$('cameraRetryBtn').addEventListener('click', startCameraMonitoring);
assessment$('assessmentHistory').addEventListener('click', () => assessment$('assessmentResults').classList.remove('hide'));
document.addEventListener('DOMContentLoaded', loadAssessmentData);
document.addEventListener('credixa:authenticated', loadAssessmentData);
document.addEventListener('credixa:resume-analyzed', loadAssessmentData);
window.addEventListener('beforeunload', () => {
  clearInterval(assessmentState.timer);
  assessmentState.stream?.getTracks().forEach(track => track.stop());
});
