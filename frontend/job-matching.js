const qualificationPatterns = [
  { label: "Bachelor's degree", pattern: /\b(bachelor'?s?|b\.?s\.?c?\.?|b\.?a\.?|undergraduate)\b/i },
  { label: "Master's degree", pattern: /\b(master'?s?|m\.?s\.?c?\.?|m\.?a\.?|m\.?b\.?a\.)\b/i },
  { label: 'Doctorate / PhD', pattern: /\b(ph\.?d\.?|doctorate)\b/i },
  { label: 'Associate degree', pattern: /\bassociate'?s?\s+degree\b/i },
  { label: 'Diploma', pattern: /\bdiploma\b/i },
  { label: 'Professional certification', pattern: /\b(certification|certified|professional certificate)\b/i },
  { label: 'Professional license', pattern: /\b(license|licensed|licensure)\b/i }
];

function exactTermInText(term, text) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'i').test(text);
}

function findJobRequirements(listing) {
  const text = `${listing.title || ''}\n${listing.category || ''}\n${listing.content || ''}`;
  const requiredSkills = (typeof skillBank === 'undefined' ? [] : skillBank).filter(skill => exactTermInText(skill, text));
  const requiredQualifications = qualificationPatterns.filter(item => item.pattern.test(text)).map(item => item.label);
  return { requiredSkills, requiredQualifications };
}

function candidateResumeProfile(text) {
  const candidateSkills = [...new Set([...(analysis?.extracted?.skills || analysis?.skills || findSkills(text))])];
  const qualificationText = (analysis?.extracted?.qualifications || extractResumeSections(text).qualifications.split(/\r?\n/).filter(Boolean)).join('\n');
  const candidateQualifications = qualificationPatterns.filter(item => item.pattern.test(qualificationText)).map(item => item.label);
  return { candidateSkills, candidateQualifications, qualificationText };
}

function matchOpportunity(listing, candidate) {
  const { requiredSkills, requiredQualifications } = findJobRequirements(listing);
  const matchingSkills = requiredSkills.filter(skill => candidate.candidateSkills.some(item => item.toLowerCase() === skill.toLowerCase()));
  const missingSkills = requiredSkills.filter(skill => !matchingSkills.includes(skill));
  const matchingQualifications = requiredQualifications.filter(item => candidate.candidateQualifications.includes(item));
  const missingQualifications = requiredQualifications.filter(item => !matchingQualifications.includes(item));
  const requirementCount = requiredSkills.length + requiredQualifications.length;
  const coveredCount = matchingSkills.length + matchingQualifications.length;
  const score = requirementCount ? Math.round((coveredCount / requirementCount) * 100) : null;
  return {
    ...listing,
    score,
    requiredSkills,
    matchingSkills,
    missingSkills,
    requiredQualifications,
    matchingQualifications,
    missingQualifications,
    matchMethod: 'Matched identifiable skills and qualifications divided by all identifiable requirements in the listing.'
  };
}

function validApplicationUrl(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

function renderOpportunity(job) {
  const required = job.requiredSkills.length ? job.requiredSkills.map(esc).join(', ') : 'No recognizable skill requirements in the listing text';
  const matched = job.matchingSkills.length ? job.matchingSkills.map(esc).join(', ') : 'None identified';
  const missing = job.missingSkills.length ? job.missingSkills.map(esc).join(', ') : 'None identified';
  const qualifications = job.requiredQualifications.length ? `Required qualifications: ${job.requiredQualifications.map(esc).join(', ')}${job.missingQualifications.length ? ` · Not detected in resume: ${job.missingQualifications.map(esc).join(', ')}` : ''}` : 'No explicit qualification requirement detected';
  const matchLabel = job.score === null ? 'Not enough listing data' : `${job.score}% skill match`;
  const kind = /intern/i.test(`${job.title} ${job.category}`) ? 'Internship' : 'Job';
  const posted = job.published_date ? `Posted ${esc(job.published_date)}` : 'Date not provided by source';
  return `<article class="job opportunity"><div class="opportunity-heading"><div><div class="job-top"><h3>${esc(job.title)}</h3><span class="match">${matchLabel}</span></div><div class="job-company">${esc(job.company || 'Company not specified by source')}</div></div><span class="opportunity-kind">${kind}</span></div><div class="job-meta"><span>${esc(job.location || 'Location not specified')}</span><span>${posted}</span><span>Source: ${esc(job.source || 'Live listing')}</span></div><div class="opportunity-details"><div><strong>Skills named in listing</strong><p>${required}</p></div><div><strong>Matching skills</strong><p class="skill-match-text">${matched}</p></div><div><strong>Missing skills</strong><p class="skill-missing-text">${missing}</p></div><div><strong>Qualifications</strong><p>${qualifications}</p></div></div><p class="opportunity-method">Match = matched identifiable skills and qualifications ÷ all identifiable requirements × 100. This is overlap, not hiring probability.</p><a class="btn primary small apply-link" href="${esc(job.url)}" target="_blank" rel="noopener noreferrer">Apply Now ↗</a></article>`;
}

function renderWorkspaceJobs(jobs) {
  $('jobsList').innerHTML = jobs.length ? jobs.map(renderOpportunity).join('') : '<div class="empty">No live opportunities matched this search. Try another location or search again later.</div>';
  $('jobsArea').classList.remove('hide');
  $('jobEmpty').classList.add('hide');
}

function jobSearchTerms(candidate, preferences) {
  const roles = (analysis?.likely_roles || []).slice(0, 4);
  return [...roles, ...candidate.candidateSkills, ...candidate.candidateQualifications, candidate.qualificationText, preferences?.role, preferences?.skills, preferences?.exp, 'jobs internships']
    .filter(Boolean).join(' ').slice(0, 3000);
}

async function searchJobs(refined = false) {
  const searchButton = $('findBtn');
  try {
    const text = resumeText();
    const candidate = candidateResumeProfile(text);
    const preferences = refined ? {
      role: $('prefRole').value.trim(),
      exp: $('prefExp').value,
      skills: $('prefSkills').value.trim(),
      location: $('prefLocation').value.trim()
    } : {};
    const location = preferences.location || 'India';
    $('jobsArea').classList.remove('hide');
    $('jobsList').innerHTML = '<div class="empty">Loading current listings…</div>';
    $('jobIntro').textContent = 'Searching live job and internship listings using resume skills and qualifications.';
    setStatus('jobStatus', 'Searching authorized live listings…');
    searchButton.disabled = true;
    $('refineBtn').disabled = true;
    const response = await fetch('/api/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        apiKey: conf.searchKey,
        query: jobSearchTerms(candidate, preferences) || text.slice(0, 500),
        location,
        candidateSkills: candidate.candidateSkills,
        candidateQualifications: candidate.candidateQualifications
      })
    });
    const data = await response.json();
    if (!response.ok) throw Error(data.notice || data.error || 'Live job search failed.');
    const listings = Array.isArray(data.results) ? data.results : [];
    const opportunities = listings.map(listing => {
      const url = validApplicationUrl(listing.url);
      return url ? matchOpportunity({ ...listing, url }, candidate) : null;
    }).filter(Boolean).sort((a, b) => {
      if (a.score === null && b.score !== null) return 1;
      if (b.score === null && a.score !== null) return -1;
      return (b.score ?? -1) - (a.score ?? -1) || b.matchingSkills.length - a.matchingSkills.length;
    });
    lastJobs = opportunities.slice(0, 12).map(job => ({
      title: job.title,
      company: job.company,
      location: job.location,
      url: job.url,
      score: job.score,
      source: job.source,
      requiredSkills: job.requiredSkills,
      matchingSkills: job.matchingSkills,
      missingSkills: job.missingSkills,
      requiredQualifications: job.requiredQualifications,
      matchingQualifications: job.matchingQualifications,
      missingQualifications: job.missingQualifications,
      postedDate: job.published_date,
      matchMethod: job.matchMethod
    }));
    renderWorkspaceJobs(opportunities);
    if (data.notice) $('jobIntro').textContent = data.notice;
    if (opportunities.length) {
      const scored = opportunities.filter(job => job.score !== null).length;
      setStatus('jobStatus', `Found ${opportunities.length} live listings from ${esc(data.source || 'the configured source')}. Ranked by identifiable skills and qualification overlap; this is not a hiring probability.`, 'ok');
      if (!scored) setStatus('jobStatus', 'Listings are live, but none contained recognizable skill or qualification requirements for a responsible percentage score.', '');
      $('step2').classList.add('done');
    } else {
      setStatus('jobStatus', data.notice || 'No live listings with valid application links matched this search.', '');
    }
    scheduleSave();
  } catch (error) {
    lastJobs = [];
    renderWorkspaceJobs([]);
    setStatus('jobStatus', error.message || 'Live job search failed. Check the source configuration and try again.', 'error');
    scheduleSave();
  } finally {
    searchButton.disabled = false;
    $('refineBtn').disabled = false;
  }
}

function renderJobs(items) {
  $('jobsList').innerHTML = items.length ? items.filter(job => validApplicationUrl(job.url)).map(job => renderOpportunity({
    ...job,
    score: job.score !== null && job.score !== undefined && Number.isFinite(Number(job.score)) ? Number(job.score) : null,
    requiredSkills: job.requiredSkills || [],
    matchingSkills: job.matchingSkills || [],
    missingSkills: job.missingSkills || [],
    requiredQualifications: job.requiredQualifications || [],
    matchingQualifications: job.matchingQualifications || [],
    missingQualifications: job.missingQualifications || [],
    published_date: job.postedDate || '',
    source: job.source || 'Saved live listing'
  })).join('') : '<div class="empty">No saved live opportunities yet.</div>';
}

window.searchJobs = searchJobs;
window.renderJobs = renderJobs;
$('findBtn').onclick = () => searchJobs(false);
$('refineBtn').onclick = () => searchJobs(true);

const jobMatchingStyle = document.createElement('style');
jobMatchingStyle.textContent = `.opportunity{display:grid;gap:14px}.opportunity-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}.opportunity-heading h3{margin:0;color:var(--primary-navy);font-size:15px;font-weight:700}.opportunity-kind{font:700 10px/1 'DM Mono',monospace;text-transform:uppercase;letter-spacing:0.5px;color:var(--primary-navy);background:#F1F5F9;border:1px solid var(--border);border-radius:4px;padding:4px 8px;white-space:nowrap}.opportunity-details{display:grid;gap:10px;padding:12px;background:var(--panel-subtle);border:1px solid var(--border);border-radius:8px}.opportunity-details strong{font-size:11px;font-weight:700;color:var(--primary-navy);text-transform:uppercase;letter-spacing:0.5px}.opportunity-details p{font-size:12px;line-height:1.5;color:var(--text-primary);margin:3px 0 0;overflow-wrap:anywhere}.opportunity-details .skill-match-text{color:var(--success);font-weight:600}.opportunity-details .skill-missing-text{color:var(--warning);font-weight:600}.opportunity-method{font-size:11px;color:var(--muted);line-height:1.45;margin:0}.apply-link{justify-self:start;text-decoration:none;font-weight:600}`;
document.head.append(jobMatchingStyle);