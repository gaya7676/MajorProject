// Credixa Main Dashboard

const $ = id => document.getElementById(id);

let currentUser = null;

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
    return true;
  } catch (e) {
    window.location.href = '/auth';
    return false;
  }
}

// Load dashboard data
async function loadDashboard() {
  try {
    const r = await fetch('/api/dashboard');
    if (!r.ok) {
      if (r.status === 401) {
        window.location.href = '/auth';
        return;
      }
      throw new Error('Could not load dashboard data.');
    }
    
    const data = await r.json();
    
    // Update user info
    $('userName').textContent = data.user.name || 'there';
    $('userEmail').textContent = data.user.name || data.user.email;
    
    // Update progress cards
    updateProgressCards(data);
    
    // Update recent activity
    updateRecentActivity(data);
    
  } catch (error) {
    console.error('Dashboard load error:', error);
  }
}

function updateProgressCards(data) {
  // Resume status
  if (data.resume.uploaded) {
    $('resumeStatus').textContent = data.atsScore ? `Analyzed (${data.atsScore}/100)` : 'Uploaded';
    $('resumeStatus').style.color = 'var(--success-text, #0B7A6B)';
  } else {
    $('resumeStatus').textContent = 'Not uploaded';
    $('resumeStatus').style.color = 'var(--muted, #52627A)';
  }
  
  // Assessment status
  const verifiedCount = countVerifiedSkills(data);
  if (verifiedCount > 0) {
    $('assessmentStatus').textContent = 'Completed';
    $('assessmentStatus').style.color = 'var(--success-text, #0B7A6B)';
  } else if (data.resume.uploaded && data.resume.extracted?.skills?.length > 0) {
    $('assessmentStatus').textContent = 'Ready to start';
    $('assessmentStatus').style.color = 'var(--warning-text, #D97706)';
  } else {
    $('assessmentStatus').textContent = 'Not started';
    $('assessmentStatus').style.color = 'var(--muted, #52627A)';
  }
  
  // Verification status
  if (verifiedCount > 0) {
    $('verificationStatus').textContent = `${verifiedCount} skill${verifiedCount > 1 ? 's' : ''} verified`;
    $('verificationStatus').style.color = 'var(--success-text, #0B7A6B)';
  } else {
    $('verificationStatus').textContent = 'Not verified';
    $('verificationStatus').style.color = 'var(--muted, #52627A)';
  }
  
  // Update Continue Workflow button
  updateContinueButton(data);
}

function updateContinueButton(data) {
  const btn = $('continueBtn');
  const hint = $('continueHint');
  
  if (!data.resume.uploaded) {
    btn.onclick = () => window.location.href = '/resume-studio';
    hint.textContent = 'Upload your resume to get started';
  } else if (!data.atsScore) {
    btn.onclick = () => window.location.href = '/resume-studio';
    hint.textContent = 'Analyze your resume to extract skills';
  } else if (countVerifiedSkills(data) === 0) {
    btn.onclick = () => window.location.href = '/skill-assessment';
    hint.textContent = 'Take skill assessment to verify your expertise';
  } else {
    btn.onclick = () => window.location.href = '/manage-verifications';
    hint.textContent = 'View and manage your verifications';
  }
}

function countVerifiedSkills(data) {
  // Count verified skills from verification records
  // This will check actual verification data once implemented
  let count = 0;
  
  // Temporary: check if there are any assessment reports with passed skills
  // The real implementation will use verification records
  if (data.resume && data.resume.extracted && data.resume.extracted.skills) {
    // For now, return 0 until verification system is fully connected
    return 0;
  }
  
  return count;
}

function updateRecentActivity(data) {
  // Removed - keeping dashboard simple
  // Activity will be shown in Manage Verifications page
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/[&<>"']/g, char => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[char]));
}

// Logout handler
$('logoutBtn').addEventListener('click', async () => {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/auth';
  } catch (e) {
    window.location.href = '/auth';
  }
});

// Initialize dashboard
(async function init() {
  const authenticated = await checkAuth();
  if (authenticated) {
    await loadDashboard();
  }
})();
