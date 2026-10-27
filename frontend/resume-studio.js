// Credixa Resume Studio

const $ = id => document.getElementById(id);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let currentUser = null;
let uploadedFile = null;
let currentHash = '';
let analysis = null;
let lastJobs = [];
let saveTimer = null;

// Configuration (stored in sessionStorage)
const conf = {
  get provider() { return sessionStorage.getItem('llm_provider') || 'openai'; },
  set provider(v) { sessionStorage.setItem('llm_provider', v); },
  get llmKey() { return sessionStorage.getItem('llm_key') || ''; },
  set llmKey(v) { sessionStorage.setItem('llm_key', v); },
  get model() { return sessionStorage.getItem('llm_model') || ''; },
  set model(v) { sessionStorage.setItem('llm_model', v); },
  get searchKey() { return sessionStorage.getItem('search_key') || ''; },
  set searchKey(v) { sessionStorage.setItem('search_key', v); }
};

// Skill bank for local analysis
const skillBank = ['JavaScript', 'TypeScript', 'Python', 'Java', 'C++', 'C#', 'Ruby', 'PHP', 'Swift', 'Kotlin', 'Go', 'Rust', 'React', 'Angular', 'Vue', 'Node.js', 'Express', 'Django', 'Flask', 'Spring', 'ASP.NET', 'Ruby on Rails', 'Laravel', 'PostgreSQL', 'MySQL', 'MongoDB', 'Redis', 'AWS', 'Azure', 'GCP', 'Docker', 'Kubernetes', 'Git', 'CI/CD', 'Jenkins', 'Terraform', 'Ansible', 'Linux', 'REST API', 'GraphQL', 'Microservices', 'Agile', 'Scrum', 'TDD', 'Machine Learning', 'Deep Learning', 'TensorFlow', 'PyTorch', 'Data Science', 'SQL', 'NoSQL', 'HTML', 'CSS', 'Sass', 'Webpack', 'Jest', 'Mocha', 'Selenium', 'Cypress'];

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

// Tab switching
function switchTab(tabName) {
  document.querySelectorAll('.studio-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.tab === tabName);
  });
  document.querySelectorAll('.studio-panel').forEach(panel => {
    panel.classList.toggle('active', panel.dataset.panel === tabName);
  });
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

// File extraction
async function extractFileText(file) {
  if (file.size > 10 * 1024 * 1024) throw Error('Please use a file smaller than 10 MB.');
  const ext = file.name.split('.').pop().toLowerCase();
  
  if (['txt', 'md'].includes(ext)) {
    return await file.text();
  }
  
  if (ext === 'docx') {
    if (!window.mammoth) throw Error('Could not load the Word document parser.');
    const b = await file.arrayBuffer();
    return (await mammoth.extractRawText({ arrayBuffer: b })).value;
  }
  
  if (ext === 'pdf') {
    if (!window.pdfjsLib) throw Error('Could not load the PDF parser.');
    const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    let all = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const p = await pdf.getPage(i);
      all.push((await p.getTextContent()).items.map(x => x.str).join(' '));
    }
    return all.join('\n');
  }
  
  throw Error('Use a PDF, DOCX, TXT, or Markdown file.');
}

// SHA-256 hash
async function sha256(file) {
  const b = await file.arrayBuffer();
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))]
    .map(x => x.toString(16).padStart(2, '0')).join('');
}

// Handle file upload
async function handleFileUpload(file) {
  if (!file) return;
  
  try {
    uploadedFile = file;
    const txt = await extractFileText(file);
    
    if (!txt.trim()) {
      throw Error('No readable text was found. This may be a scanned PDF; try an OCR version or paste the text.');
    }
    
    $('resumeText').value = txt;
    $('fileName').textContent = file.name;
    $('fileSize').textContent = (file.size / 1024).toFixed(1) + ' KB';
    $('fileInfo').classList.add('visible');
    
    currentHash = await sha256(file);
    
    setStatus('uploadStatus', 'Resume extracted locally. Ready for analysis.', 'ok');
    scheduleSave();
  } catch (error) {
    uploadedFile = null;
    setStatus('uploadStatus', error.message, 'error');
  }
}

// Drag and drop
const dropZone = $('dropZone');
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('drag-over');
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) handleFileUpload(file);
});

$('fileInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) handleFileUpload(file);
});

$('removeFile').addEventListener('click', () => {
  uploadedFile = null;
  $('resumeText').value = '';
  $('fileInfo').classList.remove('visible');
  $('fileInput').value = '';
  setStatus('uploadStatus', '');
});

// Local skill detection
function findSkills(text) {
  const lower = text.toLowerCase();
  return skillBank.filter(s => lower.includes(s.toLowerCase()));
}

// Local resume analysis
function localAnalyze(text) {
  const lower = text.toLowerCase();
  const skills = findSkills(text);
  
  let score = 25;
  const strengths = [];
  const suggestions = [];
  
  const email = /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(text);
  const phone = /\+?\d[\d\s().-]{7,}\d/.test(text);
  const experience = /experience|employment|work history|professional history/.test(lower);
  const education = /education|university|college|degree|bachelor|master/.test(lower);
  const skillSection = /skills|technologies|technical proficiencies/.test(lower);
  const metrics = /(\d+\s?%|\$\s?\d|\b\d+\+?\s+(users|customers|clients|projects|employees|hours|revenue|sales))/i.test(text);
  const actionVerbs = /\b(led|built|created|developed|delivered|improved|increased|reduced|managed|designed|implemented|launched|automated|achieved|optimized)\b/i.test(text);
  
  if (email && phone) {
    score += 10;
    strengths.push({ title: 'Contact information present', detail: 'Email and phone number are clearly visible.' });
  } else {
    suggestions.push({ title: 'Add complete contact information', priority: 'Important', detail: 'Include both email and phone number at the top.' });
  }
  
  if (experience) {
    score += 15;
    strengths.push({ title: 'Work experience section', detail: 'Professional history is documented.' });
  } else {
    suggestions.push({ title: 'Add work experience', priority: 'Critical', detail: 'Include your employment history with dates and responsibilities.' });
  }
  
  if (education) {
    score += 10;
    strengths.push({ title: 'Education section', detail: 'Academic background is listed.' });
  }
  
  if (skillSection && skills.length >= 3) {
    score += 15;
    strengths.push({ title: 'Technical skills listed', detail: `Found ${skills.length} recognizable skills.` });
  } else if (skills.length < 3) {
    suggestions.push({ title: 'List more technical skills', priority: 'Important', detail: 'Add a dedicated skills section with specific technologies and tools.' });
  }
  
  if (metrics) {
    score += 15;
    strengths.push({ title: 'Quantified achievements', detail: 'Resume includes measurable results.' });
  } else {
    suggestions.push({ title: 'Add quantified achievements', priority: 'Recommended', detail: 'Use numbers to show impact (e.g., "increased revenue by 25%").' });
  }
  
  if (actionVerbs) {
    score += 10;
    strengths.push({ title: 'Strong action verbs', detail: 'Uses impactful language to describe achievements.' });
  } else {
    suggestions.push({ title: 'Use stronger action verbs', priority: 'Recommended', detail: 'Start bullet points with verbs like "led", "developed", "improved".' });
  }
  
  if (text.length < 200) {
    suggestions.push({ title: 'Resume is too short', priority: 'Critical', detail: 'Add more detail about your experience and achievements.' });
  }
  
  return {
    mode: 'local',
    score: Math.min(100, score),
    summary: score >= 80 ? 'Strong resume structure' : score >= 60 ? 'Good foundation, some improvements needed' : 'Several key elements missing',
    strengths,
    suggestions,
    skills: skills.slice(0, 20)
  };
}

// Analyze resume
$('analyzeBtn').addEventListener('click', async () => {
  const text = $('resumeText').value.trim();
  
  if (!text) {
    setStatus('uploadStatus', 'Upload or paste your resume first.', 'error');
    return;
  }
  
  if (text.length > 40000) {
    setStatus('uploadStatus', 'Resume text is over 40,000 characters. Please shorten it.', 'error');
    return;
  }
  
  $('analyzeBtn').disabled = true;
  $('analyzeBtn').textContent = 'Analyzing...';
  setStatus('uploadStatus', 'Analyzing resume...', '');
  
  try {
    analysis = localAnalyze(text);
    renderAnalysis(analysis);
    scheduleSave();
    switchTab('analyze');
    setStatus('uploadStatus', 'Analysis complete!', 'ok');
  } catch (error) {
    setStatus('uploadStatus', error.message, 'error');
  } finally {
    $('analyzeBtn').disabled = false;
    $('analyzeBtn').textContent = '✦ Analyze Resume';
  }
});

// Render analysis results
function renderAnalysis(data) {
  $('analysisTag').textContent = data.mode === 'local' ? 'LOCAL ANALYSIS' : 'LLM ENHANCED';
  $('analysisEmpty').classList.add('hide');
  $('analysisResults').classList.remove('hide');
  
  $('scoreNumber').textContent = data.score;
  $('scoreRing').style.setProperty('--score', Math.min(100, Math.max(0, data.score)));
  $('scoreTitle').textContent = data.mode === 'local' ? 'ATS-Style Score' : 'ATS Readiness';
  $('scoreSummary').textContent = data.summary || '';
  
  $('strengthsList').innerHTML = (data.strengths || []).map(x => `
    <div class="finding">
      <div class="finding-header">
        <strong>${esc(x.title)}</strong>
        <span class="pill good">Strength</span>
      </div>
      <p>${esc(x.detail)}</p>
    </div>
  `).join('') || '<p class="panel-empty">No strengths identified.</p>';
  
  $('suggestionsList').innerHTML = (data.suggestions || []).map(x => `
    <div class="finding">
      <div class="finding-header">
        <strong>${esc(x.title)}</strong>
        <span class="pill">${esc(x.priority || 'Suggestion')}</span>
      </div>
      <p>${esc(x.detail)}</p>
    </div>
  `).join('') || '<p class="panel-empty">No suggestions at this time.</p>';
  
  if (data.skills && data.skills.length > 0) {
    $('skillsEmpty').classList.add('hide');
    $('skillsList').classList.remove('hide');
    $('skillsList').innerHTML = data.skills.map(skill => `
      <div class="skill-tag">${esc(skill)}</div>
    `).join('');
  }
  
  // Enable improve section
  $('improveEmpty').classList.add('hide');
  $('suggestionsArea').classList.remove('hide');
  
  // Enable jobs section
  $('jobsEmpty').classList.add('hide');
  $('jobsArea').classList.remove('hide');
}

// Generate AI improvements
$('generateBtn').addEventListener('click', async () => {
  if (!conf.llmKey) {
    toast('Configure an LLM API key in Settings to generate AI suggestions.');
    return;
  }
  
  const text = $('resumeText').value.trim();
  if (!text) {
    setStatus('improveStatus', 'No resume text to improve.', 'error');
    return;
  }
  
  $('generateBtn').disabled = true;
  $('generateBtn').textContent = 'Generating...';
  setStatus('improveStatus', 'Requesting AI suggestions...', '');
  
  try {
    // Placeholder - AI suggestion generation would go here
    toast('AI suggestion generation requires LLM integration.');
    setStatus('improveStatus', 'AI suggestions require full LLM integration.', 'error');
  } catch (error) {
    setStatus('improveStatus', error.message, 'error');
  } finally {
    $('generateBtn').disabled = false;
    $('generateBtn').textContent = '✦ Generate AI Suggestions';
  }
});

// Download resume
$('downloadBtn').addEventListener('click', () => {
  const text = $('resumeText').value;
  if (!text.trim()) {
    toast('No resume text to download.');
    return;
  }
  
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'resume.txt';
  a.click();
  URL.revokeObjectURL(url);
  toast('Resume downloaded!');
});

// Find jobs
$('findJobsBtn').addEventListener('click', async () => {
  const text = $('resumeText').value.trim();
  if (!text) {
    setStatus('jobsStatus', 'Analyze your resume first.', 'error');
    return;
  }
  
  $('findJobsBtn').disabled = true;
  $('findJobsBtn').textContent = 'Searching...';
  setStatus('jobsStatus', 'Searching for matching jobs...', '');
  
  try {
    const location = $('prefLocation').value.trim() || 'India';
    const skills = analysis?.skills || [];
    const query = skills.slice(0, 10).join(' ') + ' jobs hiring';
    
    const r = await fetch('/api/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        apiKey: conf.searchKey,
        query,
        location,
        candidateSkills: skills,
        candidateQualifications: []
      })
    });
    
    const data = await r.json();
    if (!r.ok) throw Error(data.error || 'Search failed');
    
    const results = data.results || [];
    if (results.length === 0) {
      $('jobsResults').innerHTML = '<div class="panel-empty"><p>No matching jobs found. Try adjusting your preferences.</p></div>';
      setStatus('jobsStatus', 'No results found.', '');
    } else {
      renderJobs(results);
      setStatus('jobsStatus', `Found ${results.length} matching opportunities.`, 'ok');
    }
  } catch (error) {
    setStatus('jobsStatus', error.message, 'error');
  } finally {
    $('findJobsBtn').disabled = false;
    $('findJobsBtn').textContent = '⌕ Find Matching Jobs';
  }
});

function renderJobs(jobs) {
  $('jobsResults').innerHTML = jobs.map(job => `
    <div class="job-card">
      <div class="job-header">
        <div>
          <h3>${esc(job.title)}</h3>
          <div class="job-company">${esc(job.company || 'See listing')}</div>
        </div>
        <div class="match-score">Match</div>
      </div>
      <div class="job-meta">
        <span>⌖ ${esc(job.location || 'See listing')}</span>
        <span>Source: ${esc(job.source || 'Web search')}</span>
      </div>
      <a class="job-link" href="${esc(job.url)}" target="_blank" rel="noopener noreferrer">
        Open listing →
      </a>
    </div>
  `).join('');
}

// Search preferences
$('refineSearchBtn').addEventListener('click', () => {
  $('searchPreferences').classList.toggle('hide');
});

$('cancelPrefsBtn').addEventListener('click', () => {
  $('searchPreferences').classList.add('hide');
});

$('searchWithPrefsBtn').addEventListener('click', () => {
  $('searchPreferences').classList.add('hide');
  $('findJobsBtn').click();
});

// Settings modal
$('settingsBtn').addEventListener('click', () => {
  $('settingsModal').classList.add('active');
  $('provider').value = conf.provider;
  $('llmKey').value = conf.llmKey;
  $('model').value = conf.model;
  $('searchKey').value = conf.searchKey;
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
  conf.searchKey = $('searchKey').value;
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

// Save profile
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveProfile, 700);
}

async function saveProfile() {
  if (!currentUser) return;
  
  try {
    const profile = {
      name: currentUser.name || '',
      resumeText: $('resumeText').value,
      fileName: uploadedFile?.name || $('fileName').textContent,
      hash: currentHash,
      analysis,
      preferences: {
        role: $('prefRole').value,
        exp: $('prefExp').value,
        skills: $('prefSkills').value,
        location: $('prefLocation').value
      },
      jobs: lastJobs
    };
    
    const r = await fetch('/api/profile', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(profile)
    });
    
    if (r.status === 401) {
      window.location.href = '/auth';
      return;
    }
    
    if (!r.ok) throw Error('Save failed');
  } catch (e) {
    console.error('Save error:', e);
  }
}

// Load profile
async function loadProfile() {
  try {
    const r = await fetch('/api/profile');
    if (!r.ok) throw Error('Could not load profile.');
    
    const data = await r.json();
    const profile = data.profile || {};
    
    if (profile.resumeText) {
      $('resumeText').value = profile.resumeText;
      $('fileName').textContent = profile.fileName || 'Saved resume';
      $('fileSize').textContent = 'Loaded from account';
      $('fileInfo').classList.add('visible');
    }
    
    if (profile.hash) {
      currentHash = profile.hash;
    }
    
    if (profile.analysis) {
      analysis = profile.analysis;
      renderAnalysis(profile.analysis);
    }
    
    if (profile.preferences) {
      $('prefRole').value = profile.preferences.role || '';
      $('prefExp').value = profile.preferences.exp || '';
      $('prefSkills').value = profile.preferences.skills || '';
      $('prefLocation').value = profile.preferences.location || '';
    }
    
    if (profile.jobs && profile.jobs.length > 0) {
      lastJobs = profile.jobs;
      renderJobs(profile.jobs);
      $('jobsEmpty').classList.add('hide');
      $('jobsArea').classList.remove('hide');
    }
  } catch (e) {
    console.error('Load error:', e);
  }
}

// Tab navigation
document.querySelectorAll('.studio-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    switchTab(tab.dataset.tab);
  });
});

// Initialize
(async function init() {
  const authenticated = await checkAuth();
  if (authenticated) {
    await loadProfile();
  }
})();
