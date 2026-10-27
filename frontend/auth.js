// Credixa Authentication Page

let authMode = 'login'; // 'login' or 'register'

const $ = id => document.getElementById(id);

function setAuthMode(mode) {
  authMode = mode;
  const create = mode === 'register';
  
  $('nameWrap').classList.toggle('hide', !create);
  $('confirmWrap').classList.toggle('hide', !create);
  $('authEyebrow').textContent = create ? 'Get started' : 'Welcome back';
  $('authTitle').textContent = create ? 'Create your Credixa account' : 'Sign in to Credixa';
  $('authDescription').textContent = create 
    ? 'Create a private workspace for your resume and career search.' 
    : 'Open your private workspace and continue where you left off.';
  $('authSubmit').textContent = create ? 'Create account' : 'Sign in';
  $('switchPrompt').textContent = create ? 'Already have an account?' : 'New to Credixa?';
  $('switchAuth').textContent = create ? 'Sign in' : 'Create an account';
  $('authPassword').autocomplete = create ? 'new-password' : 'current-password';
  $('authError').textContent = '';
}

async function authRequest(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const d = await r.json();
  if (!r.ok) throw Error(d.error || 'Account request failed.');
  return d;
}

function showError(message) {
  $('authError').textContent = message;
}

function clearError() {
  $('authError').textContent = '';
}

// Check if already logged in
async function checkSession() {
  try {
    const r = await fetch('/api/auth/me');
    if (r.ok) {
      // Already logged in, redirect to dashboard
      window.location.href = '/dashboard';
    }
  } catch (e) {
    // Not logged in, stay on auth page
  }
}

// Handle form submission
$('authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError();
  
  const email = $('authEmail').value.trim();
  const password = $('authPassword').value;
  
  if (!email || !password) {
    showError('Please enter both email and password.');
    return;
  }
  
  if (password.length < 12) {
    showError('Password must be at least 12 characters.');
    return;
  }
  
  if (authMode === 'register') {
    const name = $('authName').value.trim();
    const confirm = $('authConfirm').value;
    
    if (!name) {
      showError('Please enter your name.');
      return;
    }
    
    if (password !== confirm) {
      showError('Passwords do not match.');
      return;
    }
  }
  
  $('authSubmit').disabled = true;
  $('authSubmit').textContent = authMode === 'register' ? 'Creating account...' : 'Signing in...';
  
  try {
    if (authMode === 'register') {
      await authRequest('/api/auth/register', {
        email,
        password,
        name: $('authName').value.trim()
      });
    } else {
      await authRequest('/api/auth/login', { email, password });
    }
    
    // Successful login/registration, redirect to dashboard
    window.location.href = '/dashboard';
  } catch (error) {
    showError(error.message);
    $('authSubmit').disabled = false;
    $('authSubmit').textContent = authMode === 'register' ? 'Create account' : 'Sign in';
  }
});

// Toggle between login and register
$('switchAuth').addEventListener('click', () => {
  setAuthMode(authMode === 'login' ? 'register' : 'login');
});

// Password visibility toggle
function setupPasswordToggle(toggleId, inputId) {
  const toggle = $(toggleId);
  const input = $(inputId);
  
  if (!toggle || !input) return;
  
  toggle.addEventListener('click', () => {
    const isPassword = input.type === 'password';
    input.type = isPassword ? 'text' : 'password';
    
    // Toggle icon visibility
    const eyeOpen = toggle.querySelector('.eye-open');
    const eyeClosed = toggle.querySelector('.eye-closed');
    
    eyeOpen.classList.toggle('hide', isPassword);
    eyeClosed.classList.toggle('hide', !isPassword);
    
    // Update aria-label
    toggle.setAttribute('aria-label', isPassword ? 'Hide password' : 'Show password');
  });
}

setupPasswordToggle('togglePassword', 'authPassword');
setupPasswordToggle('toggleConfirm', 'authConfirm');

// Check URL parameters for mode
const urlParams = new URLSearchParams(window.location.search);
const mode = urlParams.get('mode');
if (mode === 'register') {
  setAuthMode('register');
}

// Check session on page load
checkSession();
