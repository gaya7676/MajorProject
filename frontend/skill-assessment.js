// Credixa Skill Assessment

const $ = id => document.getElementById(id);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let currentUser = null;
let availableSkills = [];
let questionDistribution = {};
let assessmentId = null;
let questions = [];
let currentQuestionIndex = 0;
let answers = {};
let timerInterval = null;
let remainingSeconds = 0;
let warningCount = 0;
let proctorStream = null;
let faceDetector = null;
let detectionInterval = null;

// Configuration (stored in sessionStorage)
const conf = {
  get provider() { return sessionStorage.getItem('llm_provider') || 'gemini'; },
  set provider(v) { sessionStorage.setItem('llm_provider', v); },
  get llmKey() { return sessionStorage.getItem('llm_key') || ''; },
  set llmKey(v) { sessionStorage.setItem('llm_key', v); },
  get model() { return sessionStorage.getItem('llm_model') || ''; },
  set model(v) { sessionStorage.setItem('llm_model', v); }
};

// Duration tracking for proctoring
const durationTrackers = {
  tabHidden: { start: null, total: 0 },
  faceAbsent: { start: null, total: 0 },
  multipleFaces: { start: null, total: 0 },
  headTurned: { start: null, total: 0 }
};

const lastWarningTime = new Map();

// Check authentication
async function checkAuth() {
  try {
    const r = await fetch('/api/auth/me');
    if (!r.ok) {
      window.location.href = '/auth';
      return false;
    }
    const data = await r.json();
    currentUser = data.user;
    $('userEmail').textContent = data.user.name || data.user.email;
    return true;
  } catch (e) {
    window.location.href = '/auth';
    return false;
  }
}

// Toast notification
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2400);
}

// Status message
function setStatus(id, msg, type = '') {
  const el = $(id);
  el.textContent = msg;
  el.className = 'status ' + type;
}

// Load assessment data (skills from resume)
async function loadAssessmentData() {
  try {
    const r = await fetch('/api/assessments');
    if (!r.ok) {
      if (r.status === 401) {
        window.location.href = '/auth';
        return;
      }
      throw new Error('Could not load assessment data.');
    }
    
    const data = await r.json();
    availableSkills = data.skills || [];
    
    if (availableSkills.length === 0) {
      $('skillsEmpty').classList.remove('hide');
      $('skillsArea').classList.add('hide');
      $('startAssessmentBtn').disabled = true;
    } else {
      $('skillsEmpty').classList.add('hide');
      $('skillsArea').classList.remove('hide');
      displaySkills();
      updateDistributionPreview();
      $('startAssessmentBtn').disabled = false;
    }
    
    // Load history
    if (data.reports && data.reports.length > 0) {
      renderHistory(data.reports);
    }
  } catch (error) {
    console.error('Load error:', error);
    setStatus('setupStatus', error.message, 'error');
  }
}

// Display detected skills
function displaySkills() {
  $('skillCount').textContent = availableSkills.length;
  $('skillsList').innerHTML = availableSkills.map(skill => `
    <span class="skill-tag">${esc(skill)}</span>
  `).join('');
}

// Calculate question distribution
function calculateDistribution(skills, totalQuestions) {
  if (!skills.length) return {};
  
  const basePerSkill = Math.floor(totalQuestions / skills.length);
  const remainder = totalQuestions % skills.length;
  
  const distribution = {};
  skills.forEach((skill, index) => {
    distribution[skill] = basePerSkill + (index < remainder ? 1 : 0);
  });
  
  return distribution;
}

// Update distribution preview
function updateDistributionPreview() {
  const totalQuestions = parseInt($('totalQuestions').value);
  
  if (availableSkills.length === 0) {
    $('distributionPreview').classList.add('hide');
    $('setupHint').textContent = 'Analyze your resume to detect skills first';
    return;
  }
  
  questionDistribution = calculateDistribution(availableSkills, totalQuestions);
  
  // Calculate time (1 min per question + 5 min buffer)
  const timeMinutes = totalQuestions + 5;
  
  $('previewTime').textContent = `Time limit: ${timeMinutes} minutes`;
  
  $('distributionList').innerHTML = Object.entries(questionDistribution)
    .map(([skill, count]) => `
      <div class="distribution-item">
        <span class="dist-skill">${esc(skill)}</span>
        <span class="dist-count">${count} question${count !== 1 ? 's' : ''}</span>
      </div>
    `).join('');
  
  $('distributionPreview').classList.remove('hide');
  $('setupHint').textContent = `${totalQuestions} questions across ${availableSkills.length} skill${availableSkills.length !== 1 ? 's' : ''}`;
}

// Render skills for selection (removed - no longer needed)
// function renderSkills() { ... }

// Update selected skills (removed - no longer needed)
// function updateSelectedSkills() { ... }

// Start assessment
$('startAssessmentBtn').addEventListener('click', async () => {
  if (availableSkills.length === 0) {
    toast('Analyze your resume to detect skills first.');
    return;
  }
  
  const difficulty = $('difficulty').value;
  const totalQuestions = parseInt($('totalQuestions').value);
  const thirdWarningAction = $('warningAction').value;
  
  $('startAssessmentBtn').disabled = true;
  $('startAssessmentBtn').textContent = 'Generating Questions...';
  setStatus('setupStatus', `Generating ${totalQuestions} questions across ${availableSkills.length} skills...`, '');
  
  try {
    const r = await fetch('/api/assessments/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: conf.provider || 'openai',
        apiKey: conf.llmKey || '',  // Optional - backend will use env vars if not provided
        model: conf.model || '',
        totalQuestions,
        difficulty,
        thirdWarningAction
      })
    });
    
    const data = await r.json();
    if (!r.ok) {
      // Check if it's an API key error
      if (data.error && data.error.includes('API key')) {
        toast('API key not configured. Please contact administrator or configure in Settings.');
        $('settingsBtn').click();
        throw new Error(data.error);
      }
      throw Error(data.error || 'Failed to start assessment');
    }
    
    assessmentId = data.assessmentId;
    questions = data.questions;
    questionDistribution = data.questionDistribution;
    remainingSeconds = data.minutes * 60;
    
    // Switch to exam phase
    $('setupPhase').classList.add('hide');
    $('examPhase').classList.remove('hide');
    $('historySection').classList.add('hide');
    
    // Update progress indicator
    $('progressIndicator').textContent = `Question 1/${questions.length}`;
    
    // Start camera and timer
    await startCamera();
    startTimer();
    startVisibilityMonitoring();
    
    // Show first question
    currentQuestionIndex = 0;
    renderQuestion();
    
  } catch (error) {
    setStatus('setupStatus', error.message, 'error');
    $('startAssessmentBtn').disabled = false;
    $('startAssessmentBtn').textContent = 'Start Assessment';
  }
});

// Render current question
function renderQuestion() {
  if (currentQuestionIndex < 0 || currentQuestionIndex >= questions.length) return;
  
  const q = questions[currentQuestionIndex];
  
  $('progressIndicator').textContent = `Question ${currentQuestionIndex + 1}/${questions.length}`;
  $('currentSkillBadge').textContent = q.skill;
  $('questionNumber').textContent = `Question ${currentQuestionIndex + 1}`;
  $('questionText').textContent = q.question;
  
  $('optionsList').innerHTML = q.options.map((option, index) => `
    <div class="option">
      <input type="radio" name="answer" id="opt-${index}" value="${index}" ${answers[q.id] === index ? 'checked' : ''}>
      <label for="opt-${index}">${esc(option)}</label>
    </div>
  `).join('');
  
  // Add event listeners
  document.querySelectorAll('.option input').forEach(input => {
    input.addEventListener('change', (e) => {
      answers[q.id] = parseInt(e.target.value);
    });
  });
  
  // Update navigation buttons
  $('previousBtn').disabled = currentQuestionIndex === 0;
  $('nextBtn').style.display = currentQuestionIndex < questions.length - 1 ? 'inline-flex' : 'none';
  $('submitExamBtn').style.display = currentQuestionIndex === questions.length - 1 ? 'inline-flex' : 'none';
}

// Navigation
$('previousBtn').addEventListener('click', () => {
  if (currentQuestionIndex > 0) {
    currentQuestionIndex--;
    renderQuestion();
  }
});

$('nextBtn').addEventListener('click', () => {
  if (currentQuestionIndex < questions.length - 1) {
    currentQuestionIndex++;
    renderQuestion();
  }
});

// Timer
function startTimer() {
  updateTimerDisplay();
  
  timerInterval = setInterval(() => {
    remainingSeconds--;
    updateTimerDisplay();
    
    if (remainingSeconds <= 60) {
      $('timer').classList.add('warning');
    }
    
    if (remainingSeconds <= 0) {
      submitAssessment(false, true);
    }
  }, 1000);
}

function updateTimerDisplay() {
  const mins = Math.floor(remainingSeconds / 60);
  const secs = remainingSeconds % 60;
  $('timer').textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Camera monitoring
async function startCamera() {
  try {
    proctorStream = await navigator.mediaDevices.getUserMedia({ video: true });
    $('proctorVideo').srcObject = proctorStream;
    $('cameraStatusText').textContent = 'Camera active';
    $('cameraStatusDetail').textContent = 'Monitoring in progress';
    
    // Start face detection
    await startFaceDetection();
  } catch (error) {
    $('cameraStatusText').textContent = 'Camera unavailable';
    $('cameraStatusDetail').textContent = error.message;
    await postProctorEvent('camera_permission_denied', 0, error.message);
  }
}

$('retryCameraBtn').addEventListener('click', startCamera);

async function startFaceDetection() {
  // Simplified detection - in production, use MediaPipe or similar
  detectionInterval = setInterval(() => {
    // Placeholder for face detection logic
    // In production, this would use MediaPipe FaceDetector
  }, 500);
}

function stopCamera() {
  if (proctorStream) {
    proctorStream.getTracks().forEach(track => track.stop());
    proctorStream = null;
  }
  if (detectionInterval) {
    clearInterval(detectionInterval);
    detectionInterval = null;
  }
}

// Visibility monitoring
function startVisibilityMonitoring() {
  document.addEventListener('visibilitychange', handleVisibilityChange);
}

function stopVisibilityMonitoring() {
  document.removeEventListener('visibilitychange', handleVisibilityChange);
}

function handleVisibilityChange() {
  if (document.hidden) {
    durationTrackers.tabHidden.start = Date.now();
  } else {
    if (durationTrackers.tabHidden.start) {
      const duration = Date.now() - durationTrackers.tabHidden.start;
      durationTrackers.tabHidden.total += duration;
      durationTrackers.tabHidden.start = null;
      
      if (duration >= 2000) {
        postProctorEvent('tab_hidden', duration, `Tab was hidden for ${(duration / 1000).toFixed(1)}s`);
      }
    }
  }
}

// Post proctoring event
async function postProctorEvent(type, durationMs, details) {
  if (!assessmentId) return;
  
  try {
    const r = await fetch('/api/assessments/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        assessmentId,
        type,
        durationMs,
        details
      })
    });
    
    const data = await r.json();
    if (data.warningNumber) {
      showWarning(data.warningNumber, type, details);
      warningCount = data.warnings;
      $('warningCount').textContent = `${warningCount}/3 Warnings`;
      $('warningsCounter').classList.add('has-warnings');
      
      if (data.action === 'terminate') {
        submitAssessment(true, false);
      }
    }
  } catch (error) {
    console.error('Proctoring event error:', error);
  }
}

function showWarning(number, type, details) {
  const notice = $('warningNotice');
  notice.textContent = `Warning ${number}/3: ${details}`;
  notice.classList.remove('hide');
  
  setTimeout(() => {
    notice.classList.add('hide');
  }, 5000);
}

// Submit assessment
$('submitExamBtn').addEventListener('click', () => {
  const answered = Object.keys(answers).length;
  const total = questions.length;
  
  if (answered < total) {
    if (!confirm(`You have answered ${answered} out of ${total} questions. Submit anyway?`)) {
      return;
    }
  }
  
  submitAssessment(false, false);
});

async function submitAssessment(terminated, fromTimer) {
  clearInterval(timerInterval);
  stopCamera();
  stopVisibilityMonitoring();
  
  try {
    const r = await fetch('/api/assessments/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        assessmentId,
        answers,
        terminated
      })
    });
    
    const data = await r.json();
    if (!r.ok) throw Error(data.error || 'Failed to submit assessment');
    
    // Show results
    showResults(data.report);
    
  } catch (error) {
    setStatus('examStatus', error.message, 'error');
  }
}

// Show results
function showResults(report) {
  $('examPhase').classList.add('hide');
  $('resultsPhase').classList.remove('hide');
  
  if (report.terminated) {
    $('resultsSubtitle').textContent = 'Assessment terminated due to policy violations';
  } else {
    $('resultsSubtitle').textContent = `Score: ${report.score}% (${report.correct}/${report.total} correct)`;
  }
  
  let summaryHTML = '';
  
  if (!report.terminated) {
    summaryHTML += `
      <div class="results-score">
        <div class="results-score-value">${report.score}%</div>
        <div class="results-score-label">Overall Score</div>
      </div>
    `;
  }
  
  summaryHTML += '<div class="results-breakdown">';
  
  report.perSkill.forEach(skill => {
    const verified = skill.criteriaMet && !report.terminated;
    summaryHTML += `
      <div class="skill-result">
        <div class="skill-result-info">
          <strong>${esc(skill.skill)}</strong>
          <p>${skill.correct}/${skill.total} correct ${skill.percentage !== null ? `(${skill.percentage}%)` : ''}</p>
        </div>
        <div class="skill-result-score ${verified ? 'verified' : 'not-verified'}">
          ${verified ? '✓ Verified' : 'Not Verified'}
        </div>
      </div>
    `;
  });
  
  summaryHTML += '</div>';
  
  $('resultsSummary').innerHTML = summaryHTML;
}

// New assessment
$('newAssessmentBtn').addEventListener('click', () => {
  location.reload();
});

// Render history
function renderHistory(reports) {
  if (reports.length === 0) {
    $('historyEmpty').classList.remove('hide');
    $('historyList').classList.add('hide');
    return;
  }
  
  $('historyEmpty').classList.add('hide');
  $('historyList').classList.remove('hide');
  
  $('historyList').innerHTML = reports.map(report => {
    const date = new Date(report.completedAt).toLocaleDateString();
    const skillsText = report.skills.join(', ');
    
    return `
      <div class="history-item">
        <div class="history-header">
          <div class="history-info">
            <h3>${esc(skillsText)}</h3>
            <p>${date} • ${esc(report.difficulty)} • ${report.timeLimitMinutes} min</p>
          </div>
          ${report.score !== null ? `
            <div class="history-score">${report.score}%</div>
          ` : '<div class="history-score">Terminated</div>'}
        </div>
        <div class="history-skills">
          ${report.perSkill.map(skill => `
            <span class="history-skill-tag">
              ${skill.criteriaMet ? '✓' : '✗'} ${esc(skill.skill)}
            </span>
          `).join('')}
        </div>
      </div>
    `;
  }).join('');
}

// Settings modal
$('settingsBtn').addEventListener('click', () => {
  $('settingsModal').classList.add('active');
  $('provider').value = conf.provider;
  $('llmKey').value = conf.llmKey;
  $('model').value = conf.model;
});

$('closeSettings').addEventListener('click', () => {
  $('settingsModal').classList.remove('active');
});

$('cancelSettings').addEventListener('click', () => {
  $('settingsModal').classList.remove('active');
});

$('saveSettings').addEventListener('click', () => {
  conf.provider = $('provider').value;
  conf.llmKey = $('llmKey').value;
  conf.model = $('model').value;
  $('settingsModal').classList.remove('active');
  toast('Settings saved to this tab!');
});

// Logout
$('logoutBtn').addEventListener('click', async () => {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/auth';
  } catch (e) {
    window.location.href = '/auth';
  }
});

// Question count selector event listener
$('totalQuestions').addEventListener('change', updateDistributionPreview);

// Initialize
(async function init() {
  const authenticated = await checkAuth();
  if (authenticated) {
    await loadAssessmentData();
  }
})();
