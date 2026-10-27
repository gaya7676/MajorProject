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
    if (heading) {
      activeKey = heading.key;
      continue;
    }
    if (activeKey && line) sections[activeKey] += `${sections[activeKey] ? '\n' : ''}${line}`;
  }
  return sections;
}

function resumeEvidenceLines(value) {
  return String(value || '').split(/\r?\n/).map(line => line.replace(/^\s*[-*•\u2022]+\s*/, '').trim()).filter(Boolean).slice(0, 8);
}

function detectResumeSkills(text) {
  return (typeof skillBank === 'undefined' ? [] : skillBank).filter(skill => {
    const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'i').test(text);
  });
}

function hasUnsupportedWording(source, proposal) {
  const allowedFunctionWords = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'into', 'of', 'on', 'or', 'the', 'to', 'using', 'with']);
  const sourceWords = new Set(source.toLowerCase().match(/[a-z][a-z0-9+#.]*/g) || []);
  const proposalWords = proposal.toLowerCase().match(/[a-z][a-z0-9+#.]*/g) || [];
  return proposalWords.some(word => !sourceWords.has(word) && !allowedFunctionWords.has(word));
}

function analyzeResumeText(text) {
  const lower = text.toLowerCase();
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
  const likelyRoles = [];
  if (/react|javascript|typescript|html|css/i.test(text)) likelyRoles.push('Frontend Developer');
  if (/node\.js|python|java|sql|api|backend/i.test(text)) likelyRoles.push('Backend Developer');
  if (/sql|tableau|power bi|excel|pandas/i.test(text)) likelyRoles.push('Data Analyst');
  if (/aws|azure|kubernetes|docker|terraform/i.test(text)) likelyRoles.push('Cloud / DevOps Engineer');
  const missingKeywords = criteria.filter(item => !item.met).map(item => item.label);
  return {
    mode: 'rubric',
    score: criteria.reduce((total, item) => total + item.points, 0),
    summary: 'A transparent estimate from the criteria below, not a prediction from an employer ATS. No target job description was supplied, so role-specific keyword gaps are not inferred.',
    strengths: criteria.filter(item => item.met).map(item => ({ title: item.label, detail: item.detail })),
    suggestions: [],
    skills,
    likely_roles: likelyRoles,
    experience_level: 'Not assessed',
    criteria,
    missingKeywords,
    extracted
  };
}

function renderResumeAnalysis(result) {
  analysis = result;
  $('reviewTag').textContent = 'DEFINED RUBRIC';
  $('scoreLabel').textContent = 'ATS-style rubric score';
  $('reviewEmpty').classList.add('hide');
  $('reviewResults').classList.remove('hide');
  $('scoreNum').textContent = result.score;
  $('scoreRing').style.setProperty('--score', `${result.score}%`);
  $('scoreSummary').textContent = result.summary;

  let criteriaPanel = $('rubricDetails');
  if (!criteriaPanel) {
    criteriaPanel = document.createElement('div');
    criteriaPanel.id = 'rubricDetails';
    criteriaPanel.className = 'analysis-panel';
    $('strengths').before(criteriaPanel);
  }
  criteriaPanel.innerHTML = `<div class="label">Score breakdown · 100 points</div><div class="criteria-list">${result.criteria.map(item => `<div class="criterion"><div><strong>${esc(item.label)}</strong><span>${esc(item.detail)}</span></div><b class="${item.met ? 'earned' : 'missed'}">${item.points}/${item.weight}</b></div>`).join('')}</div><div class="missing-keywords"><strong>Missing sections / keyword areas:</strong> ${result.missingKeywords.length ? esc(result.missingKeywords.join(', ')) : 'None from this general rubric.'} <span>Role-specific keyword matching requires a target job description.</span></div>`;

  let extractedPanel = $('extractedDetails');
  if (!extractedPanel) {
    extractedPanel = document.createElement('div');
    extractedPanel.id = 'extractedDetails';
    extractedPanel.className = 'analysis-panel';
    $('rubricDetails').after(extractedPanel);
  }
  const extracted = result.extracted;
  const detailBlock = (title, items) => `<section class="extracted-group"><strong>${title}</strong>${items.length ? `<ul>${items.map(item => `<li>${esc(item)}</li>`).join('')}</ul>` : '<p class="note">No clearly headed content detected.</p>'}</section>`;
  extractedPanel.innerHTML = `<div class="label">Extracted resume details</div><div class="extracted-grid">${detailBlock('Skills', extracted.skills)}${detailBlock('Qualifications', extracted.qualifications)}${detailBlock('Projects', extracted.projects)}${detailBlock('Experience', extracted.experience)}</div>`;
  $('strengths').innerHTML = result.strengths.map(item => `<div class="finding"><div class="finding-top"><strong>${esc(item.title)}</strong><span class="pill good">Met</span></div><p>${esc(item.detail)}</p></div>`).join('') || '<div class="note">No criteria met yet.</div>';
  renderAiSuggestions();
  $('editBox').classList.remove('hide');
  $('step1').classList.add('done');
  $('step2').classList.add('active');
  scheduleSave();
  document.dispatchEvent(new Event('credixa:resume-analyzed'));
}

const previousRenderReview = window.renderReview;
window.renderReview = result => {
  if (Array.isArray(result?.criteria) && result.extracted) renderResumeAnalysis(result);
  else previousRenderReview(result);
};

function renderAiSuggestions() {
  const list = $('suggestions');
  if (!analysis?.suggestions?.length) {
    list.innerHTML = '<div class="note">AI suggestions will appear here after generation. Each edit is tied to exact source text and needs your approval.</div>';
    return;
  }
  list.innerHTML = analysis.suggestions.map((item, index) => `<article class="finding suggestion-item"><div class="finding-top"><strong>${esc(item.title)}</strong><span class="pill ${item.status === 'accepted' ? 'good' : ''}">${esc(item.status || 'Pending')}</span></div><p>${esc(item.reason)}</p><div class="suggestion-copy"><span>Current text</span><p>${esc(item.source_text)}</p><span>Proposed text</span><p>${esc(item.suggested_text)}</p></div>${item.status ? '' : `<div class="actions"><button class="btn primary small" data-suggestion-action="accept" data-index="${index}">Accept edit</button><button class="btn small" data-suggestion-action="reject" data-index="${index}">Reject</button></div>`}</article>`).join('');
}

async function requestResumeSuggestions(text) {
  if (!conf.llmKey) throw Error('Add an LLM provider and API key in Settings to generate AI suggestions. The rubric analysis remains available without it.');
  const prompt = `You are editing a resume using only its supplied content. Return JSON only: {"suggestions":[{"title":"short label","reason":"specific explanation","source_text":"an exact contiguous excerpt copied from the resume","suggested_text":"a conservative rewrite of only that excerpt"}]}. Return at most 5 suggestions. Every source_text must be copied verbatim and be non-empty. Do not add or imply any new qualification, skill, project, employer, role, date, number, outcome, or achievement. Preserve all factual claims and metrics exactly. If no safe improvement exists, return an empty suggestions array. Do not give generic suggestions that require adding facts.\nResume text:\n${text}`;
  const response = await fetch('/api/llm', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: conf.provider, apiKey: conf.llmKey, model: conf.model, messages: [{ role: 'user', content: prompt }] })
  });
  const payload = await response.json();
  if (!response.ok) throw Error(payload.error || 'AI suggestion request failed.');
  const raw = payload.content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.suggestions)) throw Error('The model response did not contain a suggestions list. Try again.');
  return parsed.suggestions.slice(0, 5).filter(item => {
    if (!item || typeof item.source_text !== 'string' || typeof item.suggested_text !== 'string') return false;
    if (!item.source_text.trim() || !item.suggested_text.trim() || !text.includes(item.source_text)) return false;
    const sourceAnchors = item.source_text.match(/(?:\b\d[\d,.]*(?:%|\+)?\b|\b(?:19|20)\d{2}\b|\b[A-Z]{2,}\b)/g) || [];
    const rewritten = item.suggested_text;
    if (sourceAnchors.some(anchor => !rewritten.includes(anchor))) return false;
    return !hasUnsupportedWording(item.source_text, rewritten);
  }).map(item => ({
    title: String(item.title || 'Suggested wording').slice(0, 120),
    reason: String(item.reason || 'Wording improvement based on the provided text.').slice(0, 500),
    source_text: item.source_text,
    suggested_text: item.suggested_text,
    status: ''
  }));
}

async function generateResumeSuggestions() {
  const button = $('editBtn');
  try {
    const text = resumeText();
    button.disabled = true;
    setStatus('editStatus', 'Generating grounded suggestions…');
    const suggestions = await requestResumeSuggestions(text);
    analysis.suggestions = suggestions;
    renderAiSuggestions();
    setStatus('editStatus', suggestions.length ? 'Review each proposed change and accept or reject it individually.' : 'The model returned no safe, source-grounded edits.', 'ok');
    scheduleSave();
  } catch (error) {
    setStatus('editStatus', error.message || 'Could not generate suggestions. Check the provider configuration and try again.', 'error');
  } finally {
    button.disabled = false;
  }
}

$('analyzeBtn').onclick = async () => {
  try {
    const text = resumeText();
    $('analyzeBtn').disabled = true;
    setStatus('reviewStatus', 'Extracting sections and calculating the defined rubric…');
    renderResumeAnalysis(analyzeResumeText(text));
    setStatus('reviewStatus', 'Rubric analysis complete. AI suggestions are generated separately and are never applied automatically.', 'ok');
    if (conf.llmKey) await generateResumeSuggestions();
    else setStatus('editStatus', 'AI suggestions require an LLM provider and API key in Settings. The rubric score and extracted details are available now.', '');
    await searchJobs(false);
  } catch (error) {
    setStatus('reviewStatus', error.message || 'Could not analyze this resume.', 'error');
  } finally {
    $('analyzeBtn').disabled = false;
  }
};

$('editBtn').textContent = 'Generate AI suggestions';
$('editBtn').onclick = generateResumeSuggestions;
$('suggestions').addEventListener('click', event => {
  const button = event.target.closest('[data-suggestion-action]');
  if (!button || !analysis?.suggestions) return;
  const item = analysis.suggestions[Number(button.dataset.index)];
  if (!item || item.status) return;
  if (button.dataset.suggestionAction === 'reject') {
    item.status = 'rejected';
    renderAiSuggestions();
    scheduleSave();
    return;
  }
  const currentText = $('resume').value;
  if (!currentText.includes(item.source_text)) {
    setStatus('editStatus', 'This source text has changed. Re-analyze the current resume before applying the suggestion.', 'error');
    return;
  }
  const sourceAnchors = item.source_text.match(/(?:\b\d[\d,.]*(?:%|\+)?\b|\b(?:19|20)\d{2}\b|\b[A-Z]{2,}\b)/g) || [];
  if (sourceAnchors.some(anchor => !item.suggested_text.includes(anchor)) || hasUnsupportedWording(item.source_text, item.suggested_text)) {
    setStatus('editStatus', 'This proposed edit adds unsupported wording or changes a numeric/acronym fact, so it was not applied.', 'error');
    return;
  }
  $('resume').value = currentText.replace(item.source_text, item.suggested_text);
  item.status = 'accepted';
  uploadedFile = null;
  currentHash = '';
  $('hashValue').textContent = 'Resume draft changed. Upload the final file to calculate its fingerprint.';
  const priorSuggestions = analysis.suggestions;
  analysis = analyzeResumeText($('resume').value);
  analysis.suggestions = priorSuggestions;
  renderResumeAnalysis(analysis);
  setStatus('editStatus', 'Accepted edit applied to the draft. Check the result; no other suggestions were applied.', 'ok');
  scheduleSave();
});

$('downloadBtn').onclick = () => {
  try {
    const blob = new Blob([resumeText()], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'credixa-resume.txt';
    link.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    setStatus('editStatus', error.message, 'error');
  }
};

async function chooseFile(file) {
  if (!file) return;
  try {
    if (file.size > 10 * 1024 * 1024) throw Error('Please use a file smaller than 10 MB.');
    const extension = file.name.split('.').pop().toLowerCase();
    const signature = new Uint8Array(await file.slice(0, 5).arrayBuffer());
    if (extension === 'pdf' && String.fromCharCode(...signature.slice(0, 5)) !== '%PDF-') throw Error('This file does not have a valid PDF signature.');
    if (extension === 'docx' && !(signature[0] === 0x50 && signature[1] === 0x4b)) throw Error('This file does not have a valid DOCX signature.');
    if (!['pdf', 'docx', 'txt', 'md'].includes(extension)) throw Error('Use a PDF, DOCX, TXT, or Markdown file.');
    const text = await fileText(file);
    if (!text.trim()) throw Error('No readable text was found. This may be a scanned PDF; try an OCR version or paste the text.');
    if (text.trim().length > 40000) throw Error('Extracted resume text is over 40,000 characters. Please shorten the file before saving.');
    uploadedFile = file;
    $('resume').value = text;
    $('filename').textContent = `${file.name} · ${(file.size / 1024).toFixed(0)} KB`;
    $('fileline').classList.add('visible');
    currentHash = await sha(file);
    $('hashValue').textContent = currentHash;
    $('integrityBox').classList.remove('hide');
    $('step3').classList.add('done');
    analysis = null;
    setStatus('reviewStatus', 'Resume extracted locally. Run analysis to review the rubric and extracted details.', 'ok');
    scheduleSave();
  } catch (error) {
    $('fileInput').value = '';
    setStatus('reviewStatus', error.message || 'Could not read this file. Check its format and try again.', 'error');
  }
}

$('fileInput').onchange = event => chooseFile(event.target.files[0]);

const resumeAnalysisStyle = document.createElement('style');
resumeAnalysisStyle.textContent = `.analysis-panel{margin:16px 0;padding:16px;border:1px solid var(--border);border-radius:var(--radius);background:var(--panel-subtle)}.criteria-list{display:grid;gap:8px}.criterion{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border)}.criterion div{display:grid;gap:3px}.criterion strong{font-size:13px;font-weight:600;color:var(--primary-navy)}.extracted-group strong{font-size:12px;font-weight:700;color:var(--primary-navy);text-transform:uppercase;letter-spacing:0.5px}.criterion span{font-size:12px;color:var(--muted);line-height:1.45}.criterion b{font:700 12px 'DM Mono',monospace;white-space:nowrap}.criterion .earned{color:var(--success);background:var(--success-bg);border:1px solid var(--success-border);padding:2px 7px;border-radius:4px}.criterion .missed{color:var(--warning);background:var(--warning-bg);border:1px solid var(--warning-border);padding:2px 7px;border-radius:4px}.missing-keywords{display:grid;gap:5px;margin-top:14px;padding:12px;background:var(--warning-bg);border:1px solid var(--warning-border);border-radius:8px;font-size:12px;color:var(--warning-text);line-height:1.5;font-weight:500}.extracted-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.extracted-group{min-width:0;background:#FFFFFF;border:1px solid var(--border);border-radius:8px;padding:14px}.extracted-group ul{margin:8px 0 0;padding-left:18px;color:var(--text-primary);font-size:12px;line-height:1.55}.extracted-group li+li{margin-top:5px}.suggestion-copy{margin-top:12px;padding:14px;background:var(--panel-subtle);border:1px solid var(--border);border-radius:8px}.suggestion-copy span{font:700 11px 'DM Mono',monospace;text-transform:uppercase;letter-spacing:0.5px;color:var(--primary-navy);display:block;margin-bottom:4px}.suggestion-copy p{font-size:13px;line-height:1.5;color:var(--text-primary);margin:0 0 10px;white-space:pre-wrap;overflow-wrap:anywhere}.suggestion-item .actions{margin-top:12px}@media(max-width:480px){.extracted-grid{grid-template-columns:1fr}}`;
document.head.append(resumeAnalysisStyle);