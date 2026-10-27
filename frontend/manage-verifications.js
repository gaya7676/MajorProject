// Credixa Manage Verifications Page

const $ = id => document.getElementById(id);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let currentUser = null;
let verificationRecord = null;
let resumeData = null;

// Configuration (from existing verified-resume.js)
const conf = {
  get contractAddress() { return sessionStorage.getItem('contractAddress') || ''; },
  set contractAddress(v) { sessionStorage.setItem('contractAddress', v); }
};

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
  const status = $('verificationStatus');
  status.textContent = msg;
  status.className = 'status-message';
  status.classList.add('show');
  setTimeout(() => status.classList.remove('show'), 3000);
}

// Status message
function setStatus(msg, type = '') {
  const status = $('verificationStatus');
  status.textContent = msg;
  status.className = 'status-message ' + type;
}

// Load dashboard data
async function loadDashboardData() {
  try {
    const r = await fetch('/api/dashboard');
    if (!r.ok) {
      if (r.status === 401) {
        window.location.href = '/auth';
        return;
      }
      throw new Error('Could not load data.');
    }
    
    const data = await r.json();
    resumeData = data;
    
    // Update resume status
    if (data.resume.uploaded) {
      $('resumeUploaded').textContent = 'Uploaded';
      $('resumeUploaded').style.color = 'var(--success-text)';
    }
    
    if (data.atsScore !== null && data.atsScore !== undefined) {
      $('atsScore').textContent = `${data.atsScore}/100`;
      $('atsScore').style.color = data.atsScore >= 70 ? 'var(--success-text)' : 'var(--warning-text)';
    }
    
    const skillsCount = data.skills?.length || 0;
    $('extractedSkills').textContent = skillsCount === 0 ? '0 skills' : skillsCount === 1 ? '1 skill' : `${skillsCount} skills`;
    if (skillsCount > 0) {
      $('extractedSkills').style.color = 'var(--success-text)';
    }
    
    // Load assessment results
    await loadAssessmentResults();
    
  } catch (error) {
    console.error('Load error:', error);
    setStatus(error.message, 'error');
  }
}

// Load assessment results
async function loadAssessmentResults() {
  try {
    const r = await fetch('/api/assessments');
    if (!r.ok) throw new Error('Could not load assessments.');
    
    const data = await r.json();
    
    if (!data.reports || data.reports.length === 0) {
      $('assessmentEmpty').classList.remove('hide');
      $('assessmentResults').classList.add('hide');
      return;
    }
    
    $('assessmentEmpty').classList.add('hide');
    $('assessmentResults').classList.remove('hide');
    
    renderAssessmentResults(data.reports);
    
  } catch (error) {
    console.error('Assessment load error:', error);
  }
}

// Render assessment results
function renderAssessmentResults(reports) {
  const grid = $('resultsGrid');
  
  grid.innerHTML = reports.map(report => {
    const date = new Date(report.completedAt).toLocaleDateString();
    const verifiedSkills = report.perSkill.filter(s => s.criteriaMet).length;
    
    return `
      <div class="result-card">
        <div class="result-header">
          <h3 class="result-title">Assessment Report</h3>
          <span class="result-date">${esc(date)}</span>
        </div>
        
        <div class="result-meta">
          <span>Difficulty: <strong>${esc(report.difficulty)}</strong></span>
          <span>Duration: <strong>${Math.round(report.durationSeconds / 60)} min</strong></span>
          <span>Score: <strong>${report.score}%</strong></span>
          <span>Verified: <strong>${verifiedSkills}/${report.perSkill.length}</strong></span>
        </div>
        
        <div class="skills-breakdown">
          ${report.perSkill.map(skill => `
            <div class="skill-result">
              <div class="skill-result-info">
                <strong>${esc(skill.skill)}</strong>
                <p>${skill.correct}/${skill.total} correct (${skill.percentage}%)</p>
              </div>
              <span class="skill-badge ${skill.criteriaMet ? 'verified' : 'not-verified'}">
                ${skill.criteriaMet ? '✓ Verified' : 'Not Verified'}
              </span>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }).join('');
}

// Load verification records
async function loadVerificationRecords() {
  try {
    const r = await fetch('/api/verifications');
    if (!r.ok) throw new Error('Could not load verification records.');
    
    const data = await r.json();
    
    if (!data.records || data.records.length === 0) {
      $('verificationEmpty').classList.remove('hide');
      $('verificationRecords').classList.add('hide');
      $('downloadSection').classList.add('hide');
      return;
    }
    
    $('verificationEmpty').classList.add('hide');
    $('verificationRecords').classList.remove('hide');
    $('downloadSection').classList.remove('hide');
    
    // Store the first record for PDF generation
    verificationRecord = data.records[0];
    
    renderVerificationRecords(data.records);
    
    // Enable PDF download if we have a record
    $('downloadVerifiedPdfBtn').disabled = false;
    
  } catch (error) {
    console.error('Verification load error:', error);
    setStatus(error.message, 'error');
  }
}

// Render verification records
function renderVerificationRecords(records) {
  const grid = $('recordsGrid');
  
  grid.innerHTML = records.map(record => {
    const verifiedSkills = record.skills.filter(s => s.status === 'verified');
    const date = record.assessmentDate ? new Date(record.assessmentDate).toLocaleDateString() : 'N/A';
    
    let qrHtml = '';
    if (record.publicUrl && typeof window.qrcode === 'function') {
      try {
        const qr = window.qrcode(0, 'M');
        qr.addData(record.publicUrl, 'Byte');
        qr.make();
        const qrData = qr.createDataURL(5, 2);
        qrHtml = `<div class="record-qr"><img src="${qrData}" alt="QR Code" width="120" height="120"></div>`;
      } catch (e) {
        console.error('QR generation error:', e);
      }
    }
    
    return `
      <div class="record-card">
        <div class="record-header">
          <div class="record-info">
            <h3>Verification Record</h3>
            <code class="record-id">${esc(record.verificationId)}</code>
          </div>
          ${qrHtml}
        </div>
        
        <div class="record-details">
          <div class="record-detail-row">
            <span>Status</span>
            <strong>${esc(record.blockchainStatus === 'anchored' ? 'Blockchain Verified' : 'Not Anchored')}</strong>
          </div>
          <div class="record-detail-row">
            <span>Verified Skills</span>
            <strong>${verifiedSkills.length} of ${record.skills.length}</strong>
          </div>
          <div class="record-detail-row">
            <span>Assessment Date</span>
            <strong>${esc(date)}</strong>
          </div>
        </div>
        
        ${record.publicUrl ? `
          <a href="${esc(record.publicUrl)}" target="_blank" class="record-link">
            ${esc(record.publicUrl)}
          </a>
        ` : ''}
        
        <div class="record-actions">
          <a href="${esc(record.publicUrl)}" target="_blank" class="btn">View Public Record</a>
          ${record.blockchainStatus !== 'anchored' ? `
            <button class="btn" onclick="anchorVerification('${esc(record.verificationId)}')">Anchor on Blockchain</button>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');
}

// Create verification record
$('createVerificationBtn').addEventListener('click', async () => {
  $('createVerificationBtn').disabled = true;
  setStatus('Creating verification record...', '');
  
  try {
    const r = await fetch('/api/verifications', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({})
    });
    
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Could not create verification record.');
    
    setStatus('Verification record created successfully!', 'ok');
    
    // Reload records
    await loadVerificationRecords();
    
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    $('createVerificationBtn').disabled = false;
  }
});

// Download verified PDF
$('downloadVerifiedPdfBtn').addEventListener('click', async () => {
  if (!verificationRecord || !window.jspdf?.jsPDF) {
    setStatus('PDF library not loaded. Please refresh the page.', 'error');
    return;
  }
  
  if (!resumeData?.resume?.uploaded) {
    setStatus('Please upload a resume first.', 'error');
    return;
  }
  
  try {
    setStatus('Generating PDF...', '');
    
    // Get the resume text from profile
    const profileR = await fetch('/api/profile');
    const profileData = await profileR.json();
    const resumeText = profileData.profile.resumeText || '';
    
    if (!resumeText.trim()) {
      throw new Error('No resume text found.');
    }
    
    // Generate QR code
    const qr = window.qrcode(0, 'M');
    qr.addData(verificationRecord.publicUrl, 'Byte');
    qr.make();
    const qrData = qr.createDataURL(6, 2);
    
    // Create PDF
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ unit: 'mm', format: 'a4' });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const left = 18;
    const right = pageWidth - 18;
    let y = 18;
    
    // Header with badge
    pdf.setFillColor(20, 45, 78);
    pdf.rect(0, 0, pageWidth, 36, 'F');
    pdf.setTextColor(255, 255, 255);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(18);
    pdf.text('CREDIXA VERIFIED SKILLS', left, 16);
    
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(9);
    pdf.setTextColor(153, 226, 216);
    pdf.text('Skill verification backed by proctored assessment', left, 24);
    
    pdf.setFontSize(8);
    pdf.text(`Verification ID: ${verificationRecord.verificationId}`, left, 31);
    
    // QR Code in top-right
    pdf.addImage(qrData, 'PNG', right - 29, 5, 25, 25);
    
    y = 45;
    
    // Skills verification status
    pdf.setTextColor(20, 45, 78);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(12);
    pdf.text('Verified Skills', left, y);
    y += 7;
    
    pdf.setFontSize(9);
    pdf.setFont('helvetica', 'normal');
    
    for (const skill of verificationRecord.skills) {
      if (skill.status === 'verified') {
        pdf.setFont('helvetica', 'bold');
        pdf.text(skill.skill, left, y);
        pdf.setFont('helvetica', 'normal');
        pdf.text(`✓ Verified · ${skill.score}% score`, left + 52, y);
        y += 6;
        if (y > pageHeight - 22) {
          pdf.addPage();
          y = 20;
        }
      }
    }
    
    y += 10;
    
    // Resume content
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(12);
    pdf.text('Resume', left, y);
    y += 7;
    
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(9);
    
    const lines = pdf.splitTextToSize(resumeText, right - left);
    for (const line of lines) {
      if (y > pageHeight - 16) {
        pdf.addPage();
        y = 18;
      }
      pdf.text(line, left, y);
      y += 4.5;
    }
    
    // Footer on all pages
    const pages = pdf.getNumberOfPages();
    for (let pageNumber = 1; pageNumber <= pages; pageNumber++) {
      pdf.setPage(pageNumber);
      pdf.setFontSize(7);
      pdf.setTextColor(120, 130, 134);
      pdf.text('Credixa Verified Skills · Assessment evidence only', left, pageHeight - 8);
      pdf.text(`${pageNumber}/${pages}`, right, pageHeight - 8, { align: 'right' });
    }
    
    pdf.save('credixa-verified-skills-resume.pdf');
    setStatus('PDF downloaded successfully!', 'ok');
    
  } catch (error) {
    setStatus(`PDF generation failed: ${error.message}`, 'error');
  }
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

// Initialize
(async function init() {
  const authenticated = await checkAuth();
  if (authenticated) {
    await loadDashboardData();
    await loadVerificationRecords();
  }
})();
