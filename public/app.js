console.log('MediTrack Script Loaded');
window.onerror = (msg, url, line) => {
  console.error('JS Error:', msg, url, line);
};

let token = localStorage.getItem('mt_token') || '';
let currentUser = JSON.parse(localStorage.getItem('mt_user') || 'null');
let socket = null;
let medicines = [];
let doctors = [];
let appointments = [];
let notifications = [];
let selectedDoctorId = null;
let notifCount = 0;

// ─── INIT ──────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  const savedTheme = localStorage.getItem('mt_theme') || 'light';
  applyTheme(savedTheme);

  // Fetch Config and Init Google
  try {
    const configRes = await fetch('/api/config');
    const config = await configRes.json();
    if (config.googleClientId) {
      google.accounts.id.initialize({
        client_id: config.googleClientId,
        callback: handleGoogleCallback
      });
      google.accounts.id.renderButton(
        document.getElementById('google-btn-container'),
        { theme: 'filled_blue', size: 'large', text: 'signin_with', shape: 'rectangular' }
      );
    } else {
      console.warn('GOOGLE_CLIENT_ID not found in .env');
      document.getElementById('google-btn-container').innerHTML =
        '<p style="color:#f6851b; font-size:0.8rem;">⚠️ Google Sign-In not configured. Add GOOGLE_CLIENT_ID to .env</p>';
    }
  } catch (e) {
    console.error('Config fetch failed:', e);
  }

  // Check for reset token in URL
  const urlParams = new URLSearchParams(window.location.search);
  const resetToken = urlParams.get('resetToken');
  if (resetToken) {
    showAuth();
    toggleAuthMode('forgot');
    document.getElementById('forgot-step-1').classList.add('hidden');
    document.getElementById('forgot-step-2').classList.remove('hidden');
    document.title = 'MediTrack - Reset Password';
    window.currentResetToken = resetToken;
    return;
  }

  if (token && currentUser) {
    showApp();
  } else {
    showAuth();
  }
});

// ─── AUTH ──────────────────────────────────────────
function showAuth() {
  document.getElementById('auth-screen').classList.remove('hidden');
  document.getElementById('app-screen').classList.add('hidden');
}

function showApp() {
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('app-screen').classList.remove('hidden');

  initPanels();
  initSocket();
  loadProfile();

  // Refresh user data from server (to get full avatar if local was truncated)
  apiFetch('/api/user/profile').then(res => res.json()).then(user => {
    if (user && user._id) {
      currentUser = { ...user, id: user._id };
      safeSaveUser(currentUser);
      loadProfile();
    }
  }).catch(e => console.warn('Profile refresh failed:', e));

  // Start Medicine Alarm Checker
  if (!window.alarmInterval) {
    window.alarmInterval = setInterval(checkMedicineAlarms, 60000);
    checkMedicineAlarms();
  }

  if (currentUser.role === 'admin') {
    switchTab('admin-dash');
  } else if (currentUser.role === 'doctor') {
    switchTab('doctor-appointments');
  } else {
    switchTab('medicines');
  }
}

function initPanels() {
  const role = currentUser ? (currentUser.role || 'user') : 'user';
  const badge = document.getElementById('role-badge');
  if (badge) badge.textContent = role.charAt(0).toUpperCase() + role.slice(1);

  // Show the correct panel container
  document.querySelectorAll('.role-panel').forEach(p => p.classList.add('hidden'));
  const activePanel = document.getElementById(`panel-${role}`);
  if (activePanel) {
    activePanel.classList.remove('hidden');
    console.log(`Un-hid panel-${role}`);
  }

  // Show the correct nav group
  document.querySelectorAll('.nav-group').forEach(g => g.classList.add('hidden'));
  const activeNav = document.getElementById(`nav-group-${role}`);
  if (activeNav) activeNav.classList.remove('hidden');
}

function toggleAuthMode(mode) {
  document.getElementById('login-form').classList.add('hidden');
  document.getElementById('otp-form').classList.add('hidden');
  document.getElementById('signup-form').classList.add('hidden');
  document.getElementById('forgot-form').classList.add('hidden');

  if (mode === 'otp') {
    document.getElementById('otp-form').classList.remove('hidden');
    document.getElementById('otp-step-1').classList.remove('hidden');
    document.getElementById('otp-step-2').classList.add('hidden');
    document.getElementById('otp-send-error').textContent = '';
    document.getElementById('otp-verify-error').textContent = '';
  } else if (mode === 'signup') {
    document.getElementById('signup-form').classList.remove('hidden');
  } else if (mode === 'forgot') {
    document.getElementById('forgot-form').classList.remove('hidden');
    document.getElementById('forgot-step-1').classList.remove('hidden');
    document.getElementById('forgot-step-2').classList.add('hidden');
    document.getElementById('forgot-send-error').textContent = '';
    document.getElementById('forgot-reset-error').textContent = '';
    document.getElementById('forgot-success').textContent = '';
  } else if (mode === 'mfa') {
    document.getElementById('mfa-form').classList.remove('hidden');
    document.getElementById('login-form').classList.add('hidden');
    document.getElementById('otp-form').classList.add('hidden');
    document.getElementById('mfa-code').value = '';
    document.getElementById('mfa-error').textContent = '';
  } else if (mode === 'wallet') {
    document.getElementById('wallet-auth').classList.remove('hidden');
    document.getElementById('login-form').classList.add('hidden');
    document.getElementById('wallet-link-step-1').classList.remove('hidden');
    document.getElementById('wallet-link-step-2').classList.add('hidden');
  } else {
    document.getElementById('login-form').classList.remove('hidden');
  }
}

async function register() {
  const name = document.getElementById('signup-name').value.trim();
  const email = document.getElementById('signup-email').value.trim();
  const phone = document.getElementById('signup-phone').value.trim();
  const password = document.getElementById('signup-password').value;
  const errEl = document.getElementById('signup-error');
  errEl.textContent = '';

  if (!name || !email || !phone || !password) { errEl.textContent = 'All fields are required'; return; }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) { errEl.textContent = 'Please enter a valid email address'; return; }

  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, phone, password })
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.message; return; }

    if (data.mfaRequired) {
      window.mfaUserId = data.userId;
      document.getElementById('mfa-info').textContent = data.message || "Please verify your email address. Code sent to " + data.mfaEmail;
      toggleAuthMode('mfa');
      showToast('Verify your email to continue', 'info');
      if (data.demoCode) showToast(`🔑 Registration Code: ${data.demoCode}`, 'info');
      return;
    }

    token = data.token;
    currentUser = data.user;
    localStorage.setItem('mt_token', token);
    safeSaveUser(currentUser);

    showApp();
  } catch (e) {
    errEl.textContent = 'Server connection failed';
  }
}

// ─── OTP LOGIN ──────────────────────────────────────
async function sendOtp() {
  const phone = document.getElementById('otp-phone').value.trim();
  const errEl = document.getElementById('otp-send-error');
  errEl.textContent = '';

  if (!phone) { errEl.textContent = 'Enter your phone number'; return; }

  try {
    const res = await fetch('/api/auth/send-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone })
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.message; return; }

    // Show OTP input step
    document.getElementById('otp-step-1').classList.add('hidden');
    document.getElementById('otp-step-2').classList.remove('hidden');
    showToast(`📱 SMS: Your OTP is ${data.demoCode}`, 'success');
  } catch (e) {
    console.error('Fetch Error:', e);
    errEl.textContent = 'Server connection failed: ' + e.message;
  }
}

async function verifyOtp() {
  const phone = document.getElementById('otp-phone').value.trim();
  const otp = document.getElementById('otp-code').value.trim();
  const errEl = document.getElementById('otp-verify-error');
  errEl.textContent = '';

  if (!otp) { errEl.textContent = 'Enter the 6-digit OTP'; return; }

  try {
    const res = await fetch('/api/auth/verify-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, otp })
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.message; return; }

    if (data.mfaRequired) {
      window.mfaUserId = data.userId;
      document.getElementById('mfa-info').textContent = `Verification code sent to ${data.mfaEmail}`;
      toggleAuthMode('mfa');
      showToast('Step 2: Enter Email Code', 'info');
      return;
    }

    token = data.token;
    currentUser = data.user;
    localStorage.setItem('mt_token', token);
    safeSaveUser(currentUser);

    showApp();
  } catch (e) {
    console.error('Fetch Error:', e);
    errEl.textContent = 'Server connection failed: ' + e.message;
  }
}

function resendOtp() {
  document.getElementById('otp-step-2').classList.add('hidden');
  document.getElementById('otp-step-1').classList.remove('hidden');
  document.getElementById('otp-code').value = '';
  sendOtp();
}

// ─── FORGOT PASSWORD (EMAIL-BASED) ──────────────────
async function sendForgotPasswordEmail() {
  const email = document.getElementById('forgot-email').value.trim();
  const errEl = document.getElementById('forgot-send-error');
  errEl.textContent = '';
  errEl.style.color = '';

  if (!email) { errEl.textContent = '⚠️ Please enter your email address'; return; }

  // Validate email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    errEl.textContent = '❌ Invalid email format. Please enter a valid email address.';
    return;
  }

  // Disable button while processing
  const btn = event.target;
  const oldText = btn.textContent;
  btn.textContent = 'Sending...';
  btn.disabled = true;

  try {
    const res = await fetch('/api/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const data = await res.json();

    if (!res.ok) {
      // Show the error prominently (e.g. "No account found with this email")
      errEl.textContent = '❌ ' + data.message;
      errEl.style.color = '#ff4d4d';
      document.getElementById('forgot-email').style.borderColor = '#ff4d4d';
      setTimeout(() => { document.getElementById('forgot-email').style.borderColor = ''; }, 3000);
      btn.textContent = oldText;
      btn.disabled = false;
      return;
    }

    showToast(data.message, 'success');
    if (data.demoLink) {
      console.log('DEMO RESET LINK:', data.demoLink);
      showToast('Check console for reset link!', 'info');
    }

    // Show success state (keep form accessible for retry)
    errEl.style.color = '#107c10';
    errEl.textContent = '✅ Reset link sent to ' + email + '! Check your inbox.';
    document.getElementById('forgot-email').value = '';
    btn.textContent = 'Resend Link';
    btn.disabled = false;

  } catch (e) {
    console.error('Fetch Error:', e);
    errEl.textContent = '❌ Server connection failed: ' + e.message;
    btn.textContent = oldText;
    btn.disabled = false;
  }
}

async function resetPasswordByEmail() {
  const token = window.currentResetToken;
  const newPassword = document.getElementById('forgot-new-password').value;
  const errEl = document.getElementById('forgot-reset-error');
  const successEl = document.getElementById('forgot-success');
  errEl.textContent = '';
  successEl.textContent = '';

  if (!token) { errEl.textContent = 'Invalid session. Please request a new link.'; return; }
  if (!newPassword || newPassword.length < 6) { errEl.textContent = 'Password must be at least 6 characters'; return; }

  try {
    const res = await fetch('/api/auth/reset-password-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, newPassword })
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.message; return; }

    successEl.textContent = '✅ ' + data.message;
    showToast('Password updated successfully!', 'success');

    // Auto-switch to login after 3 seconds
    setTimeout(() => {
      // Clear URL params
      window.history.replaceState({}, document.title, "/");
      toggleAuthMode('login');
    }, 3000);
  } catch (e) {
    console.error('Fetch Error:', e);
    errEl.textContent = 'Server connection failed: ' + e.message;
  }
}

async function handleGoogleCallback(response) {
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';

  try {
    const res = await fetch('/api/auth/google-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: response.credential })
    });

    const data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.message || 'Login failed';
      return;
    }

    if (data.mfaRequired) {
      window.mfaUserId = data.userId;
      document.getElementById('mfa-info').textContent = "Step 2: Google MFA check. Code sent to " + data.mfaEmail;
      toggleAuthMode('mfa');
      showToast('Verify your Gmail OTP', 'info');
      return;
    }

    // Direct login successful (should not happen with mandatory MFA but handled for safety)
    token = data.token;
    currentUser = data.user;
    localStorage.setItem('mt_token', token);
    safeSaveUser(currentUser);
    showApp();
  } catch (e) {
    console.error('Google Login Error:', e);
    errEl.textContent = 'Server connection failed: ' + e.message;
  }
}

async function login() {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';

  if (!email || !password) { errEl.textContent = 'Enter email and password'; return; }

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.message; return; }

    if (data.mfaRequired) {
      window.mfaUserId = data.userId;
      document.getElementById('mfa-info').textContent = "Verification code sent to " + data.mfaEmail;
      toggleAuthMode('mfa');
      showToast('Step 2: Authenticate', 'info');
      return;
    }

    token = data.token;
    currentUser = data.user;
    localStorage.setItem('mt_token', token);
    safeSaveUser(currentUser);
    showApp();
  } catch (e) {
    console.error('Login Error:', e);
    errEl.textContent = 'Server connection failed: ' + e.message;
  }
}

async function verifyMfaLogin() {
  const mfaOtp = document.getElementById('mfa-code').value.trim();
  const errEl = document.getElementById('mfa-error');
  errEl.textContent = '';

  if (mfaOtp.length < 6) return errEl.textContent = 'Enter 6-digit code';

  try {
    const res = await fetch('/api/auth/verify-mfa', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: window.mfaUserId, mfaOtp })
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.message; return; }

    token = data.token;
    currentUser = data.user;
    localStorage.setItem('mt_token', token);
    safeSaveUser(currentUser);
    showApp();
    showToast('Login successful!', 'success');
  } catch (e) { errEl.textContent = 'Verification error'; }
}

async function resendMfaCode() {
  if (!window.mfaUserId) return showToast('Session expired, please login again.', 'error');
  try {
    const res = await fetch('/api/auth/resend-mfa', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: window.mfaUserId })
    });
    const data = await res.json();
    if (res.ok) {
      showToast(data.message, 'success');
      if (data.demoCode) showToast(`🔄 New OTP: ${data.demoCode}`, 'info');
    } else {
      showToast(data.message || 'Resend failed', 'error');
    }
  } catch (e) { showToast('Server connection failed', 'error'); }
}

async function connectWallet() {
  if (!window.ethereum) return alert('MetaMask not found. Please install the extension.');
  try {
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    const walletAddress = accounts[0];
    window.tempWallet = walletAddress;

    // Check if wallet is already linked
    const res = await fetch('/api/auth/wallet/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress })
    });
    const data = await res.json();

    if (data.exists) {
      // Success - directly show email OTP input for verification
      document.getElementById('wallet-email').value = data.email;
      document.getElementById('wallet-email').readOnly = true;
      document.getElementById('wallet-auth-header').textContent = 'Wallet Connected';
      document.getElementById('wallet-auth-info').textContent = `Security Check: Sending code to ${data.email.replace(/(.{2})(.*)(@.*)/, "$1***$3")}`;
      toggleAuthMode('wallet');
      sendWalletLinkOtp(); // Auto-send for existing wallets
    } else {
      // New wallet - ask for email to link
      document.getElementById('wallet-email').value = '';
      document.getElementById('wallet-email').readOnly = false;
      document.getElementById('wallet-auth-header').textContent = 'Link New Wallet';
      document.getElementById('wallet-auth-info').textContent = 'Connect this wallet to your account via email OTP.';
      toggleAuthMode('wallet');
    }
  } catch (e) { console.error('Wallet Error:', e); }
}

async function sendWalletLinkOtp() {
  const email = document.getElementById('wallet-email').value.trim();
  if (!email) return showToast('Please enter your email', 'error');

  try {
    const res = await fetch('/api/auth/wallet/send-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, walletAddress: window.tempWallet })
    });
    const data = await res.json();
    if (res.ok) {
      document.getElementById('wallet-link-step-1').classList.add('hidden');
      document.getElementById('wallet-link-step-2').classList.remove('hidden');
      showToast(`Verification code sent to email!`, 'success');
      if (data.demoCode) showToast(`🔑 [DEMO] OTP: ${data.demoCode}`, 'info');
    } else { showToast(data.message, 'error'); }
  } catch (e) { showToast('Server error', 'error'); }
}

async function verifyWalletOtp() {
  const email = document.getElementById('wallet-email').value.trim();
  const otp = document.getElementById('wallet-otp').value.trim();
  if (!otp) return showToast('Enter the code', 'error');

  try {
    const res = await fetch('/api/auth/wallet/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, walletAddress: window.tempWallet, otp })
    });
    const data = await res.json();
    if (res.ok) {
      token = data.token;
      currentUser = data.user;
      localStorage.setItem('mt_token', token);
      safeSaveUser(currentUser);
      showApp();
      showToast('Wallet verified & logged in!', 'success');
    } else { showToast(data.message, 'error'); }
  } catch (e) { showToast('Server error', 'error'); }
}

function logout() {
  localStorage.clear();
  location.reload();
}

// ─── SOCKET.IO ─────────────────────────────────────
function initSocket() {
  if (socket) socket.disconnect();
  socket = io();
  socket.on('connect', () => socket.emit('join-room', token));

  socket.on('notification', (notif) => {
    notifications.unshift(notif);
    renderNotifications();
    showToast(notif.message, 'info');
  });

  socket.on('medicine-added', (med) => {
    medicines.unshift(med);
    renderMedicines();
    showToast(`Medicine "${med.name}" added`, 'success');
  });

  socket.on('medicine-status-updated', (med) => {
    const idx = medicines.findIndex(m => m._id === med._id);
    if (idx !== -1) {
      medicines[idx] = med;
      renderMedicines();
    }
  });

  socket.on('appointment-status-updated', (apt) => {
    const idx = appointments.findIndex(a => a._id === apt._id);
    if (idx !== -1) {
      appointments[idx] = apt;
      renderAppointments();
    }
    showToast(`Appointment for ${apt.date} is now ${apt.status}`, apt.status === 'confirmed' ? 'success' : 'info');
  });

  socket.on('online-count', (count) => {
    const el = document.getElementById('online-count-val');
    if (el) el.textContent = count;
  });

  socket.on('appointment-update', (data) => {
    // This listener might be for general updates, or new appointments.
    // Assuming it's for new appointments or updates that should be added/refreshed.
    // If it's a new appointment, add it. If it's an update, find and replace.
    const idx = appointments.findIndex(a => a._id === data._id);
    if (idx !== -1) {
      appointments[idx] = data;
    } else {
      appointments.unshift(data); // Add new appointment
    }
    renderAppointments();
    showToast('Appointment updated!', 'success'); // Changed message to be more general
  });

  socket.on('appointment-added', (apt) => {
    appointments.unshift(apt);
    renderAppointments();
    showToast('New appointment booked!', 'success');
  });

  socket.on('doctor-added', (newDoc) => {
    // If doctors-container exists (user panel), update and re-render
    const el = document.getElementById('doctors-container');
    const searchInput = document.getElementById('doctor-search');
    if (el) {
      doctors.unshift(newDoc);
      renderDoctorsUI(searchInput ? searchInput.value.toLowerCase().trim() : '');
      showToast(`New specialist added: ${newDoc.name}`, 'success');
    }
    // If admin is viewing, refresh dashboard data
    if (currentUser && currentUser.role === 'admin') {
      fetchAdminData();
    }
  });
}

// ─── TABS ───────────────────────────────────────────
function switchTab(tab) {
  console.log('Switching to tab:', tab);
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(el => el.classList.remove('active'));

  const targetTab = document.getElementById(`tab-${tab}`);
  if (targetTab) {
    targetTab.classList.add('active');
    console.log('Target tab found and activated');
  } else {
    console.warn('Target tab not found:', `tab-${tab}`);
  }

  // Highlight correct tab
  const tabs = document.querySelectorAll('.nav-tab');
  tabs.forEach(t => {
    if (t.getAttribute('onclick')?.includes(`'${tab}'`)) t.classList.add('active');
  });

  if (tab === 'medicines') fetchMedicines();
  if (tab === 'doctors') fetchDoctors();
  if (tab === 'notifications') fetchNotifications();
  if (tab === 'admin-dash') fetchAdminData();
  if (tab === 'admin-appointments') fetchAdminAptData('all');
  if (tab === 'doctor-appointments') fetchAppointments();
  if (tab === 'doctor-analytics') fetchDoctorAnalytics();
  if (tab === 'doctor-monitor') fetchDoctorMonitor();
  if (tab === 'user-appointments') fetchMyAppointments();
}

// Review Logic
let currentReviewAptId = null;
let currentReviewDocId = null;
let currentStars = 0;

function openReviewModal(aptId, docId, docName) {
  currentReviewAptId = aptId;
  currentReviewDocId = docId;
  currentStars = 0;
  document.getElementById('review-doctor-label').textContent = `How was your visit with ${docName}?`;
  document.getElementById('review-comment').value = '';
  document.getElementById('review-error').textContent = '';

  // Reset stars
  document.querySelectorAll('.star-btn').forEach(s => s.style.color = '#ccc');

  document.getElementById('reviewModal').classList.add('active');
}

function selectStar(n) {
  currentStars = n;
  const stars = document.querySelectorAll('.star-btn');
  stars.forEach((s, idx) => {
    s.style.color = (idx < n) ? '#f1c40f' : '#ccc';
  });
}

async function submitReview() {
  if (currentStars === 0) {
    document.getElementById('review-error').textContent = 'Please select a rating';
    return;
  }

  const comment = document.getElementById('review-comment').value.trim();

  try {
    const res = await apiFetch(`/api/doctors/${currentReviewDocId}/reviews`, 'POST', {
      stars: currentStars,
      comment,
      appointmentId: currentReviewAptId
    });

    if (res.ok) {
      showToast('Review submitted! Thank you.', 'success');
      closeModal('reviewModal');
      fetchMyAppointments(); // Refresh list to hide "Rate Doctor"
    } else {
      const data = await res.json();
      document.getElementById('review-error').textContent = data.message || 'Submission failed';
    }
  } catch (e) {
    document.getElementById('review-error').textContent = 'Connection error';
  }
}

async function viewDoctorReviews(docId) {
  try {
    const res = await apiFetch(`/api/doctors/${docId}/reviews`);
    const reviews = await res.json();

    const container = document.getElementById('reviews-list-container');
    const label = document.getElementById('view-reviews-label');

    if (Array.isArray(reviews)) {
      label.textContent = `Showing latest ${reviews.length} reviews`;
      container.innerHTML = reviews.length ? reviews.map(r => `
        <div class="review-item" style="padding: 15px; border-bottom: 1px solid rgba(0,0,0,0.05); margin-bottom: 10px; background: rgba(0,0,0,0.02); border-radius: 12px;">
          <div style="display: flex; justify-content: space-between; margin-bottom: 5px;">
            <b style="font-size: 0.9rem;">${r.userId ? r.userId.name : 'Patient'}</b>
            <span style="color: #f1c40f;">${'★'.repeat(r.stars)}${'☆'.repeat(5 - r.stars)}</span>
          </div>
          <p style="font-size: 0.85rem; opacity: 0.8; line-height: 1.4;">${r.comment || 'No comment provided.'}</p>
          <small style="opacity: 0.5; font-size: 0.7rem;">${new Date(r.createdAt).toLocaleDateString()}</small>
        </div>
      `).join('') : '<p style="text-align:center; padding: 40px 0; opacity: 0.5;">No reviews yet for this doctor.</p>';

      document.getElementById('viewReviewsModal').classList.add('active');
    }
  } catch (e) {
    showToast('Failed to load reviews', 'error');
  }
}

async function fetchMyAppointments() {
  try {
    const res = await apiFetch('/api/appointments');
    const data = await res.json();
    if (Array.isArray(data)) {
      appointments = data;
      renderMyAppointments();
    }
  } catch (e) {
    console.error('Fetch my apts failed:', e);
  }
}

function renderMyAppointments() {
  const el = document.getElementById('user-apt-ul');
  if (!el || !Array.isArray(appointments)) return;

  el.innerHTML = appointments.length ? appointments.map(a => `
    <li class="med-item" style="flex-direction: column; align-items: flex-start; gap: 8px;">
      <div style="width: 100%; display: flex; justify-content: space-between; align-items: center;">
        <div>
          <b>${a.doctorId.name || 'Doctor'}</b> 
          <span style="opacity: 0.6; font-size: 0.8em;">Specialist</span> 
        </div>
        <div class="badge badge-${a.status}">${a.status}</div>
      </div>
      <div style="width: 100%; display: flex; justify-content: space-between; align-items: flex-end;">
        <div style="font-size: 0.85em; opacity: 0.7;">
          📅 ${a.date} | 🕐 ${a.time} | 💳 ${a.paymentStatus}
        </div>
        ${(a.status === 'pending' || a.status === 'confirmed') ? 
          `<button onclick="cancelAppointment('${a._id}')" style="background: var(--danger); color: white; border: none; padding: 5px 12px; border-radius: 6px; font-size: 0.8rem; cursor: pointer;">Cancel</button>` 
          : ''}
        ${(a.status === 'confirmed' && !a.reviewed) ? 
          `<button onclick="openReviewModal('${a._id}', '${a.doctorId._id}', '${a.doctorId.name}')" style="background: var(--primary); color: white; border: none; padding: 5px 12px; border-radius: 6px; font-size: 0.8rem; cursor: pointer; margin-left: 5px;">Rate Doctor</button>` 
          : ''}
      </div>
    </li>
  `).join('') : '<li style="opacity:0.6;text-align:center;">No appointments booked</li>';
}

async function cancelAppointment(id) {
  if (!confirm('Are you sure you want to cancel this appointment?')) return;
  
  try {
    const res = await apiFetch(`/api/appointments/${id}/status`, 'PATCH', { status: 'cancelled' });
    if (res.ok) {
      showToast('Appointment cancelled successfully', 'info');
      fetchMyAppointments();
    } else {
      const data = await res.json();
      showToast(data.message || 'Cancellation failed', 'error');
    }
  } catch (e) {
    showToast('Connection error', 'error');
  }
}

// ─── USER FEATURES ──────────────────────────────────
async function fetchMedicines() {
  try {
    const res = await apiFetch('/api/medicines');
    const data = await res.json();
    if (Array.isArray(data)) {
      medicines = data;
      renderMedicines();
    }
  } catch (e) { console.error('Medicines fetch error:', e); }
}

function renderMedicines() {
  const ulToTake = document.getElementById('ulToTake');
  const ulTaken = document.getElementById('ulTaken');
  if (!ulToTake || !ulTaken || !Array.isArray(medicines)) return;

  const toTake = medicines.filter(m => m.status !== 'taken');
  const taken = medicines.filter(m => m.status === 'taken');

  ulToTake.innerHTML = toTake.length ? toTake.map(m => `
    <li class="med-item">
      <div><b>${m.name}</b><span style="opacity:0.7;font-size:0.9em;margin-left:7px;">${m.time}</span></div>
      <div class="med-actions"><button onclick="toggleStatus('${m._id}')">Taken</button></div>
    </li>
  `).join('') : '<li style="opacity:0.6;text-align:center;">No medicines to take</li>';

  ulTaken.innerHTML = taken.length ? taken.map(m => `
    <li class="med-item">
      <div><b>${m.name}</b><span style="opacity:0.7;font-size:0.9em;margin-left:7px;">${m.time}</span></div>
      <div class="med-actions"><button onclick="toggleStatus('${m._id}')">Undo</button></div>
    </li>
  `).join('') : '<li style="opacity:0.6;text-align:center;">No medicines taken</li>';
}

function checkMedicineAlarms() {
  if (!currentUser || currentUser.role !== 'user' || !medicines.length) return;

  const now = new Date();
  const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

  const dueMeds = medicines.filter(m => m.time === currentTime && m.status === 'pending');

  if (dueMeds.length > 0) {
    const alarmSound = document.getElementById('alarm-sound');
    if (alarmSound) {
      alarmSound.play().catch(e => console.warn('Audio play blocked:', e));
    }

    dueMeds.forEach(m => {
      showToast(`⏰ ALARM: Time to take your ${m.name}!`, 'info');
      // Only notify once per minute
      if (!window.notifiedMeds) window.notifiedMeds = new Set();
      if (!window.notifiedMeds.has(m._id + currentTime)) {
        showToast(`Take ${m.name} now!`, 'success');
        window.notifiedMeds.add(m._id + currentTime);
      }
    });
  }
}

async function fetchDoctors() {
  try {
    const res = await apiFetch('/api/doctors');
    const data = await res.json();
    console.log('Fetched doctors:', data);
    if (Array.isArray(data)) {
      doctors = data;
      renderDoctorsUI();
    } else {
      console.error('API did not return an array of doctors:', data);
    }
  } catch (err) {
    console.error('Failed to fetch doctors:', err);
  }
}

function filterDoctors() {
  const searchTerm = document.getElementById('doctor-search').value.toLowerCase().trim();
  renderDoctorsUI(searchTerm);
}

function renderDoctorsUI(searchTerm = '') {
  const el = document.getElementById('doctors-container');
  if (!el) return;

  const displayedDoctors = doctors.filter(d => {
    if (!searchTerm) return true;
    const spec = (d.specialty || 'General').toLowerCase();
    return spec.includes(searchTerm);
  });

  if (!Array.isArray(displayedDoctors) || displayedDoctors.length === 0) {
    el.innerHTML = searchTerm
      ? `<div style="text-align:center; padding: 60px 20px;">
          <div style="font-size: 3rem; margin-bottom: 20px; opacity: 0.3;">🔎</div>
          <p style="opacity: 0.5; font-size: 1.1rem;">No specialists found for "<b>${searchTerm}</b>"</p>
          <button class="btn" onclick="document.getElementById('doctor-search').value=''; filterDoctors()" style="margin-top: 15px; color: var(--primary); background: transparent;">Clear Search</button>
         </div>`
      : '<p style="text-align:center; padding: 20px; opacity: 0.6;">No doctors available at the moment.</p>';
    return;
  }

  el.innerHTML = `
    <div class="doctor-category">
      <h2>${searchTerm ? `Results for "${searchTerm}"` : 'All Specialists'}</h2>
      <div class="doctor-cards">
        ${displayedDoctors.map(d => {
    const defaultImg = `https://randomuser.me/api/portraits/men/${Math.floor(Math.random() * 20 + 50)}.jpg`;
    const finalImg = (d.image && (d.image.startsWith('http') || d.image.startsWith('data:image')))
      ? d.image
      : defaultImg;
    return `
            <div class="doctor-card">
              <img src="${finalImg}" alt="${d.name}">
              <div class="doc-name">${d.name}</div>
              <div class="doc-spec">${d.specialty || 'General'}</div>
              <div class="doctor-meta"><span>⭐ ${d.rating || 4.5}</span><span>Exp: ${d.experience || 0}yr</span></div>
              <button class="btn-book" onclick="openBooking('${d._id}','${d.name}')">Book Visit</button>
            </div>
          `;
  }).join('')}
      </div>
    </div>
  `;
}

// ─── DOCTOR FEATURES ────────────────────────────────
async function fetchAppointments() {
  try {
    const res = await apiFetch('/api/appointments');
    const data = await res.json();
    if (Array.isArray(data)) {
      appointments = data;
      renderAppointments();
    }
  } catch (e) { console.error('Appointments fetch error:', e); }
}

function renderAppointments() {
  const el = document.getElementById('doctor-apt-ul');
  if (!el || !Array.isArray(appointments)) return;
  
  // Only show pending and confirmed appointments in the main Schedule tab
  const activeApts = appointments.filter(a => a.status === 'pending' || a.status === 'confirmed');
  
  el.innerHTML = activeApts.length ? activeApts.map(a => `
    <li class="med-item" style="flex-direction: column; align-items: flex-start;">
      <div style="width: 100%; display: flex; justify-content: space-between; align-items: center;">
        <div><b>${a.patientName}</b><span style="opacity:0.7;font-size:0.9em;margin-left:7px;">${a.date} at ${a.time}</span></div>
        <div class="badge badge-${a.status}">${a.status}</div>
      </div>
        <div class="med-actions" style="margin-top: 10px; gap: 10px; display: flex;">
          ${a.status === 'pending' ? `
            <button onclick="updateAppointmentStatus('${a._id}', 'confirmed')" style="background: var(--primary); border: none; padding: 5px 12px; border-radius: 4px; color: white; cursor: pointer;">Confirm</button>
            <button onclick="updateAppointmentStatus('${a._id}', 'cancelled')" style="background: #ff4d4d; border: none; padding: 5px 12px; border-radius: 4px; color: white; cursor: pointer;">Reject</button>
          ` : ''}
          ${a.status === 'confirmed' ? `
            <button onclick="updateAppointmentStatus('${a._id}', 'completed')" style="background: #fff; color: var(--primary); border: 1px solid var(--primary); padding: 5px 12px; border-radius: 4px; cursor: pointer; font-weight: 600;">✅ Complete meeting</button>
            <button onclick="openPrescribeModal('${a._id}', '${a.userId._id || a.userId}', '${a.patientName}')" style="background: var(--success); border: none; padding: 5px 12px; border-radius: 4px; color: white; cursor: pointer;">💊 Prescribe</button>
          ` : ''}
          <button onclick="openPatientRecordsModal('${a.userId._id || a.userId}', '${a.patientName}')" style="background: rgba(0,0,0,0.1); border: 1px solid rgba(0,0,0,0.1); padding: 5px 12px; border-radius: 4px; color: var(--text); cursor: pointer; font-size: 0.85rem;">📋 View Records</button>
        </div>
      </li>
  `).join('') : '<li style="opacity:0.6;text-align:center; padding: 20px;">No pending or active appointments found.</li>';
}

async function updateAppointmentStatus(id, status) {
  const res = await apiFetch(`/api/appointments/${id}/status`, 'PATCH', { status });
  if (res.ok) {
    const apt = await res.json();
    const idx = appointments.findIndex(a => a._id === apt._id);
    if (idx !== -1) {
      appointments[idx] = apt;
      renderAppointments();
    }
    showToast(`Appointment ${status}`, 'success');
  } else {
    const data = await res.json();
    showToast(data.message || 'Update failed', 'error');
  }
}

let prescribeAptId = null;
let prescribeUserId = null;

function addPrescribeRow() {
  const container = document.getElementById('prescribe-medicines-container');
  const div = document.createElement('div');
  div.className = 'prescribe-med-row';
  div.style = "display: grid; grid-template-columns: 2fr 1fr 1fr 1fr 1.5fr auto; gap: 8px; margin-bottom: 15px; align-items: end; background: rgba(255,255,255,0.03); padding: 12px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.05);";
  div.innerHTML = `
    <div class="form-group" style="margin-bottom:0;">
      <label style="font-size: 0.75rem; opacity: 0.7;">Medicine Name</label>
      <input type="text" class="med-name" placeholder="Paracetamol" required style="width:100%; padding:8px; border-radius:6px; border:1px solid rgba(0,0,0,0.1); background:var(--secondary); color:var(--text); font-size: 0.9rem;">
    </div>
    <div class="form-group" style="margin-bottom:0;">
      <label style="font-size: 0.75rem; opacity: 0.7;">Dosage</label>
      <input type="text" class="med-dosage" placeholder="500mg" required style="width:100%; padding:8px; border-radius:6px; border:1px solid rgba(0,0,0,0.1); background:var(--secondary); color:var(--text); font-size: 0.9rem;">
    </div>
    <div class="form-group" style="margin-bottom:0;">
      <label style="font-size: 0.75rem; opacity: 0.7;">Time</label>
      <input type="time" class="med-time" required style="width:100%; padding:8px; border-radius:6px; border:1px solid rgba(0,0,0,0.1); background:var(--secondary); color:var(--text); font-size: 0.9rem;">
    </div>
    <div class="form-group" style="margin-bottom:0;">
      <label style="font-size: 0.75rem; opacity: 0.7;">Days</label>
      <input type="number" class="med-days" value="5" min="1" required style="width:100%; padding:8px; border-radius:6px; border:1px solid rgba(0,0,0,0.1); background:var(--secondary); color:var(--text); font-size: 0.9rem;">
    </div>
    <div class="form-group" style="margin-bottom:0;">
      <label style="font-size: 0.75rem; opacity: 0.7;">Notes</label>
      <input type="text" class="med-notes" placeholder="After meal" style="width:100%; padding:8px; border-radius:6px; border:1px solid rgba(0,0,0,0.1); background:var(--secondary); color:var(--text); font-size: 0.9rem;">
    </div>
    <button onclick="removePrescribeRow(this)" style="background: rgba(255, 77, 77, 0.1); color: #ff4d4d; border: 1px solid rgba(255, 77, 77, 0.2); border-radius: 6px; padding: 8px; cursor: pointer;">🗑️</button>
  `;
  container.appendChild(div);
}

function removePrescribeRow(btn) {
  const container = document.getElementById('prescribe-medicines-container');
  if (container.children.length > 1) {
    btn.parentElement.remove();
  } else {
    showToast('At least one medicine is required', 'error');
  }
}

function openPrescribeModal(aptId, userId, patientName) {
  prescribeAptId = aptId;
  prescribeUserId = userId;
  document.getElementById('prescribe-patient-label').textContent = `Adding medicine for ${patientName}`;
  const container = document.getElementById('prescribe-medicines-container');
  container.innerHTML = '';
  addPrescribeRow(); // Start with one row
  // Hide remove button for the first row as it's the only one
  container.querySelector('button').style.visibility = 'hidden';
  
  document.getElementById('prescribe-error').textContent = '';
  document.getElementById('prescribeModal').classList.add('active');
}

async function submitPrescription() {
  const rows = document.querySelectorAll('.prescribe-med-row');
  const medicinesToPrescribe = [];
  const errEl = document.getElementById('prescribe-error');
  errEl.textContent = '';

  let valid = true;
  rows.forEach(row => {
    const name = row.querySelector('.med-name').value.trim();
    const dosage = row.querySelector('.med-dosage').value.trim();
    const time = row.querySelector('.med-time').value;
    const days = parseInt(row.querySelector('.med-days').value) || 1;
    const notes = row.querySelector('.med-notes').value.trim();

    if (!name || !dosage || !time) {
      valid = false;
    } else {
      medicinesToPrescribe.push({ name, dosage, time, totalDays: days, notes });
    }
  });

  if (!valid) {
    errEl.textContent = 'All fields (name, dosage, time) are required for each medicine';
    return;
  }

  if (medicinesToPrescribe.length === 0) {
    errEl.textContent = 'Add at least one medicine';
    return;
  }

  try {
    const res = await apiFetch('/api/medicines/prescribe', 'POST', {
      patientId: prescribeUserId,
      medicines: medicinesToPrescribe
    });

    if (res.ok) {
      showToast('Prescriptions saved successfully!', 'success');
      closeModal('prescribeModal');
    } else {
      const data = await res.json();
      errEl.textContent = data.message || 'Prescription failed';
    }
  } catch (e) {
    errEl.textContent = 'Connection error';
  }
}

async function openPatientRecordsModal(userId, patientName) {
  document.getElementById('patient-records-label').textContent = `Records for ${patientName}`;
  const listContainer = document.getElementById('patient-med-history-list');
  const summaryContainer = document.getElementById('patient-records-summary-container');
  
  listContainer.innerHTML = '<p style="text-align:center; padding: 20px; opacity: 0.6;">Loading data...</p>';
  summaryContainer.innerHTML = '';
  document.getElementById('patientRecordsModal').classList.add('active');

  try {
    const res = await apiFetch(`/api/medicines/patient/${userId}`);
    const hMeds = await res.json();

    if (res.ok && Array.isArray(hMeds)) {
      const totalRecords = hMeds.length;
      const completedCount = hMeds.filter(m => (m.daysCompleted >= (m.totalDays || 1))).length;
      const activeCount = totalRecords - completedCount;

      if (totalRecords > 0) {
        // SUMMARY BANNERS
        summaryContainer.innerHTML = `
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 5px;">
            <div style="background: var(--primary); color: #fff; padding: 12px; border-radius: 12px; text-align: center; box-shadow: 0 4px 12px rgba(0, 120, 212, 0.2);">
              <div style="font-size: 0.7rem; opacity: 0.8; text-transform: uppercase;">Total Prescribed</div>
              <div style="font-size: 1.4rem; font-weight: 700;">${totalRecords}</div>
            </div>
            <div style="background: var(--success); color: #fff; padding: 12px; border-radius: 12px; text-align: center; box-shadow: 0 4px 12px rgba(16, 124, 16, 0.2);">
              <div style="font-size: 0.7rem; opacity: 0.8; text-transform: uppercase;">Completed Plan</div>
              <div style="font-size: 1.4rem; font-weight: 700;">${completedCount}</div>
            </div>
          </div>
          <div style="font-size: 0.8rem; margin: 15px 0 5px; opacity: 0.6; font-weight: 600; display: flex; align-items: center; gap: 6px;">
            <span style="width: 8px; height: 8px; background: var(--primary); border-radius: 50%;"></span> 
            ACTIVE TREATMENT TIMELINE
          </div>
        `;

        listContainer.innerHTML = hMeds.map(m => {
          const total = m.totalDays || 1;
          const done = m.daysCompleted || 0;
          const remaining = Math.max(0, total - done);
          const progress = Math.min(Math.round((done / total) * 100), 100);
          const isCompleted = done >= total;

          return `
            <div class="med-item" style="margin-bottom: 12px; display: block; padding: 12px; border-radius: 10px; background: rgba(0,0,0,0.02); border: 1px solid ${isCompleted ? 'rgba(16, 124, 16, 0.15)' : 'rgba(0,0,0,0.05)'};">
              <div style="display:flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;">
                <div>
                  <b style="color:${isCompleted ? 'var(--success)' : 'var(--text)'}; font-size: 1rem;">${m.name}</b>
                  <div style="font-size: 0.75rem; opacity: 0.6;">${m.dosage}</div>
                </div>
                <div style="text-align: right;">
                  <span class="badge" style="background: ${isCompleted ? 'var(--success)' : 'var(--primary)'}; font-size: 0.65rem; padding: 3px 8px;">
                    ${isCompleted ? 'FINISHED' : `${remaining}d Left`}
                  </span>
                  <div style="font-size: 0.7rem; opacity: 0.6; margin-top: 3px;">Day ${done}/${total}</div>
                </div>
              </div>
              
              <div style="width: 100%; height: 6px; background: rgba(0,0,0,0.05); border-radius: 3px; overflow: hidden; margin-bottom: 6px;">
                <div style="width: ${progress}%; height: 100%; background: ${isCompleted ? 'var(--success)' : 'var(--primary)'}; transition: width 0.4s cubic-bezier(0.1, 0.7, 1.0, 0.1);"></div>
              </div>

              ${m.notes ? `<div style="font-size: 0.75rem; font-style: italic; opacity: 0.5; padding-top: 6px; border-top: 1px dashed rgba(0,0,0,0.05);">Note: ${m.notes}</div>` : ''}
            </div>
          `;
        }).join('');
      } else {
        listContainer.innerHTML = '<div style="text-align:center; padding: 40px 0;"><div style="font-size: 2.5rem; opacity: 0.2; margin-bottom: 10px;">📋</div><p style="opacity: 0.5;">No records found for this patient.</p></div>';
      }
    } else {
      listContainer.innerHTML = `<div style="color:var(--danger); text-align:center; padding: 20px;">${hMeds.message || 'Error occurred'}</div>`;
    }
  } catch (err) {
    listContainer.innerHTML = '<div style="color:var(--danger); text-align:center; padding: 20px;">Network failure</div>';
  }
}



// ─── ADMIN FEATURES ─────────────────────────────────
async function fetchAdminData() {
  try {
    const resStats = await apiFetch('/api/admin/stats');
    const stats = await resStats.json();
    const elStats = document.getElementById('admin-stats');
    if (elStats && stats && typeof stats === 'object' && 'totalUsers' in stats) {
      elStats.innerHTML = `
        <div class="med-list"><h3>Total Users</h3><h2 style="text-align:center;color:var(--primary)">${stats.totalUsers}</h2></div>
        <div class="med-list"><h3>Doctors</h3><h2 style="text-align:center;color:var(--primary)">${stats.totalDoctors}</h2></div>
        <div class="med-list"><h3>Appointments</h3><h2 style="text-align:center;color:var(--primary)">${stats.totalAppointments}</h2></div>
        <div class="med-list" style="border: 2px solid var(--primary); background: rgba(0, 120, 212, 0.05);">
          <h3 style="color:var(--primary)">🟢 Live Online</h3>
          <h2 style="text-align:center; color: #00ff00;">${stats.onlineCount || 0}</h2>
          <div style="font-size:0.7em; text-align:center; opacity:0.6;">Active Sessions</div>
        </div>
      `;
    }

    const resUsers = await apiFetch('/api/admin/users');
    const users = await resUsers.json();
    const elUsers = document.getElementById('admin-user-ul');
    if (elUsers && Array.isArray(users)) {
      elUsers.innerHTML = users.map(u => `
        <li class="med-item" style="flex-wrap: wrap; gap: 10px;">
          <div style="flex: 1; min-width: 150px;">
            <b>${u.name}</b><span style="opacity:0.7;font-size:0.9em;margin-left:7px;">${u.email}</span>
            <div class="badge" style="margin-top: 5px; display: inline-block;">${u.role}</div>
          </div>
          <div class="med-actions" style="display: flex; gap: 10px;">
            <select onchange="updateUserRole('${u._id}', this.value)" style="padding: 5px; border-radius: 6px; background: var(--secondary); color: var(--text); border: 1px solid var(--primary); outline: none;">
              <option value="user" ${u.role === 'user' ? 'selected' : ''}>User Role</option>
              <option value="doctor" ${u.role === 'doctor' ? 'selected' : ''}>Doctor Role</option>
              <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin Role</option>
            </select>
            <button style="background: var(--danger);" onclick="deleteUser('${u._id}')">Delete</button>
          </div>
        </li>
      `).join('');
    }
  } catch (e) {
    console.error('Admin data fetch error:', e);
  }
}

async function fetchAdminAptData(status) {
  // Update UI filters
  document.querySelectorAll('#tab-admin-appointments .btn').forEach(b => {
    b.style.background = 'var(--secondary)';
    b.style.color = 'var(--text)';
  });
  const activeBtn = document.getElementById(`apt-filter-${status}`);
  if (activeBtn) {
    activeBtn.style.background = status === 'all' ? 'var(--primary)' :
      status === 'confirmed' ? 'var(--success)' :
        status === 'cancelled' ? 'var(--danger)' : 'var(--primary)';
    activeBtn.style.color = '#fff';
  }

  try {
    const res = await apiFetch(`/api/admin/appointments?status=${status}`);
    const apts = await res.json();
    renderAdminAptUI(apts);
  } catch (e) {
    console.error('Admin apt fetch error:', e);
  }
}

function renderAdminAptUI(apts) {
  const el = document.getElementById('admin-apt-ul');
  if (!el) return;

  el.innerHTML = apts.length ? apts.map(a => `
    <li class="med-item" style="flex-direction: column; align-items: flex-start; gap: 8px;">
      <div style="width: 100%; display: flex; justify-content: space-between; align-items: center;">
        <div>
          <b>${a.patientName}</b> 
          <span style="opacity: 0.6; font-size: 0.8em;">with</span> 
          <b style="color: var(--primary);">${a.doctorName}</b>
        </div>
        <div class="badge badge-${a.status}">${a.status}</div>
      </div>
      <div style="width: 100%; display: flex; justify-content: space-between; align-items: flex-end;">
        <div style="font-size: 0.85em; opacity: 0.7;">
          📅 ${a.date} | 🕐 ${a.time} | 💰 ₹${a.amount || 500}
          <div style="font-size: 0.8em; margin-top: 2px;">TXN: ${a.transactionId || 'N/A'}</div>
        </div>
        ${a.status === 'pending' ? `
          <div style="display: flex; gap: 6px;">
            <button onclick="updateAdminAptStatus('${a._id}', 'confirmed')" style="background: var(--success); color: white; border: none; padding: 4px 10px; border-radius: 4px; font-size: 0.75rem; cursor: pointer;">Verify</button>
            <button onclick="updateAdminAptStatus('${a._id}', 'cancelled')" style="background: var(--danger); color: white; border: none; padding: 4px 10px; border-radius: 4px; font-size: 0.75rem; cursor: pointer;">Cancel</button>
          </div>
        ` : ''}
      </div>
    </li>
  `).join('') : '<li style="text-align:center; padding: 30px; opacity: 0.5;">No matching appointments found.</li>';
}

async function updateAdminAptStatus(id, status) {
  try {
    const res = await apiFetch(`/api/appointments/${id}/status`, 'PATCH', { status });
    if (res.ok) {
      showToast(`Appointment ${status} successfully`, 'success');
      fetchAdminAptData('all');
    }
  } catch (e) {
    showToast('Update failed', 'error');
  }
}

function filterAdminApts(status) {
  fetchAdminAptData(status);
}

// ─── DOCTOR ANALYTICS ──────────────────────────────
async function fetchDoctorAnalytics() {
  try {
    const res = await apiFetch('/api/doctors/analytics');
    const data = await res.json();
    if (res.ok) {
      renderDoctorInsights(data);
    }
  } catch (e) {
    console.error('Analytics error:', e);
  }
}

function renderDoctorInsights(data) {
  const container = document.getElementById('doctor-insights-container');
  if (!container) return;

  let analyticsHtml = `
    <div class="med-list" style="padding: 20px; text-align: center;">
      <div style="font-size: 0.8em; opacity: 0.6; margin-bottom: 5px;">Patients Treated</div>
      <div style="font-size: 1.8rem; font-weight: 700; color: var(--primary);">${data.totalPatients}</div>
    </div>
    <div class="med-list" style="padding: 20px; text-align: center;">
      <div style="font-size: 0.8em; opacity: 0.6; margin-bottom: 5px;">Avg Rating</div>
      <div style="font-size: 1.8rem; font-weight: 700; color: #f1c40f;">⭐ ${data.rating}</div>
    </div>
    <div class="med-list" style="padding: 20px; text-align: center;">
      <div style="font-size: 0.8em; opacity: 0.6; margin-bottom: 5px;">Satisfaction</div>
      <div style="font-size: 1.8rem; font-weight: 700; color: var(--success);">${data.satisfaction}%</div>
    </div>
    <div class="med-list" style="padding: 20px; text-align: center;">
      <div style="font-size: 0.8em; opacity: 0.6; margin-bottom: 5px;">Met Patients</div>
      <div style="font-size: 1.8rem; font-weight: 700; color: var(--primary);">${data.completedAppointments}</div>
    </div>
  `;

  // Add the list of completed patients
  analyticsHtml += `
    <div style="width: 100%; margin-top: 35px;">
      <h3 style="margin-bottom: 20px; color: var(--primary); display: flex; align-items: center; gap: 10px;">
        📜 Recent Patient Meetings 
        <span style="background: var(--primary); color: white; border-radius: 12px; font-size: 0.7em; padding: 2px 10px;">Met</span>
      </h3>
      <div class="med-list" style="padding: 0; background: transparent; box-shadow: none;">
        <ul class="med-ul" style="padding: 0; max-height: none;">
          ${data.completedPatients && data.completedPatients.length ? data.completedPatients.map(p => `
            <li class="med-item" style="margin-bottom: 12px; padding: 18px; border: 1px solid rgba(0, 120, 212, 0.1); background: rgba(0, 120, 212, 0.02);">
              <div style="flex: 1;">
                <b style="font-size: 1.1rem; color: var(--text);">${p.patientName}</b>
                <div style="font-size: 0.85rem; opacity: 0.6; margin-top: 4px;">Met on ${p.date} at ${p.time}</div>
              </div>
              <div style="text-align: right;">
                <div style="font-weight: 700; color: var(--success); font-size: 1.1rem;">₹${p.amount}</div>
                <div class="badge badge-completed" style="margin-top: 5px; font-size: 0.7rem; padding: 2px 10px; border-radius: 6px;">COMPLETED</div>
              </div>
            </li>
          `).join('') : '<li style="text-align:center; padding: 40px; background: rgba(0,0,0,0.02); border-radius: 12px; opacity: 0.5;">No meetings completed yet.</li>'}
        </ul>
      </div>
    </div>
  `;

  container.innerHTML = analyticsHtml;
  document.getElementById('doc-rev-val').textContent = `₹${data.revenue.toLocaleString()}`;
}

// ─── DOCTOR HEALTH MONITOR ──────────────────────────
async function fetchDoctorMonitor() {
  const container = document.getElementById('doctor-monitor-list');
  if (!container) return;
  container.innerHTML = '<p style="text-align:center; padding: 40px; opacity: 0.6;">Analyzing patient adherence data...</p>';

  try {
    const res = await apiFetch('/api/doctors/monitor');
    const data = await res.json();
    if (res.ok) {
        renderDoctorMonitor(data);
    } else {
        container.innerHTML = `<p style="color:var(--danger); text-align:center; padding: 40px;">${data.message || 'Failed to load monitor data'}</p>`;
    }
  } catch (e) {
    container.innerHTML = '<p style="color:var(--danger); text-align:center; padding: 40px;">Network error loading monitor</p>';
  }
}

function renderDoctorMonitor(data) {
  const container = document.getElementById('doctor-monitor-list');
  if (!container) return;

  if (!data || data.length === 0) {
    container.innerHTML = `
      <div style="text-align:center; padding: 60px 20px;">
        <div style="font-size: 3rem; margin-bottom: 20px; opacity: 0.2;">🩺</div>
        <p style="opacity: 0.6; font-size: 1.1rem;">No patients to monitor yet.</p>
        <p style="opacity: 0.4; font-size: 0.9rem; margin-top: 10px;">Patients will appear here once you complete their consultation.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = `
    <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 20px;">
      ${data.map(p => {
        const statusColor = p.status === 'Good' ? 'var(--success)' : (p.status === 'Fair' ? 'orange' : 'var(--danger)');
        return `
          <div class="med-list" style="padding: 20px; position: relative; border-top: 4px solid ${statusColor};">
            <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 15px;">
              <div>
                <b style="font-size: 1.15rem; color: var(--text);">${p.patientName}</b>
                <div style="font-size: 0.8rem; opacity: 0.6;">${p.patientEmail}</div>
              </div>
              <span class="badge" style="background: ${statusColor}; color: white; border: none; font-size: 0.7rem; font-weight: 700;">${p.status.toUpperCase()}</span>
            </div>

            <div style="display: flex; align-items: center; gap: 20px; margin-bottom: 20px;">
               <div style="width: 60px; height: 60px; border-radius: 50%; background: #f0f0f0; display: flex; align-items: center; justify-content: center; position: relative;">
                  <svg width="60" height="60" viewBox="0 0 60 60">
                    <circle cx="30" cy="30" r="26" fill="none" stroke="#ddd" stroke-width="4"></circle>
                    <circle cx="30" cy="30" r="26" fill="none" stroke="${statusColor}" stroke-width="4" stroke-dasharray="${(p.overallAdherence / 100) * 163.36} 163.36" transform="rotate(-90 30 30)"></circle>
                  </svg>
                  <span style="position: absolute; font-size: 0.75rem; font-weight: 700;">${p.overallAdherence}%</span>
               </div>
               <div style="flex: 1;">
                 <div style="font-size: 0.85rem; font-weight: 600;">Overall Adherence</div>
                 <div style="font-size: 0.75rem; opacity: 0.6;">${p.completedPrescriptions} of ${p.totalPrescriptions} courses completed</div>
               </div>
            </div>

            <button onclick="openPatientRecordsModal('${p.userId}', '${p.patientName}')" 
                    style="width: 100%; background: rgba(0, 120, 212, 0.05); color: var(--primary); border: 1px dashed var(--primary); padding: 10px; border-radius: 8px; font-weight: 600; cursor: pointer; transition: 0.2s;">
              View Full History
            </button>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

async function updateUserRole(userId, role) {
  const res = await apiFetch(`/api/admin/users/${userId}/role`, 'PATCH', { role });
  if (res.ok) {
    showToast('User role updated successfully', 'success');
    fetchAdminData();
  } else {
    const data = await res.json();
    showToast(data.message || 'Failed to update role', 'error');
  }
}

async function deleteUser(userId) {
  if (!confirm('Are you sure you want to delete this user? This action cannot be undone.')) return;
  const res = await apiFetch(`/api/admin/users/${userId}`, 'DELETE');
  if (res.ok) {
    showToast('User deleted successfully', 'success');
    fetchAdminData();
  } else {
    const data = await res.json();
    showToast(data.message || 'Failed to delete user', 'error');
  }
}

// ─── CREATE DOCTOR (Admin) ──────────────────────────
async function createDoctorAccount() {
  const errEl = document.getElementById('create-doctor-error');
  const successEl = document.getElementById('create-doctor-success');
  errEl.textContent = '';
  successEl.textContent = '';

  const name = document.getElementById('doc-name').value.trim();
  const email = document.getElementById('doc-email').value.trim();
  const password = document.getElementById('doc-password').value.trim();
  const specialty = document.getElementById('doc-specialty').value.trim();
  const hospital = document.getElementById('doc-hospital').value.trim();
  const experience = parseInt(document.getElementById('doc-experience').value) || 0;
  const fee = parseInt(document.getElementById('doc-fee').value) || 500;
  const image = document.getElementById('doc-image').value.trim();
  const bio = document.getElementById('doc-bio').value.trim();

  if (!name || !email || !password || !specialty || !hospital) {
    errEl.textContent = 'Name, email, password, specialty and hospital are required';
    return;
  }

  const res = await apiFetch('/api/admin/create-doctor', 'POST', {
    name, email, password, specialty, hospital, experience, fee, image, bio
  });
  const data = await res.json();

  if (!res.ok) {
    errEl.textContent = data.message || 'Failed to create doctor';
    return;
  }

  successEl.textContent = `✅ Doctor created! Login: ${data.credentials.email} / ${data.credentials.password}`;
  showToast('Doctor account created successfully!', 'success');

  // Clear form
  ['doc-name', 'doc-email', 'doc-password', 'doc-specialty', 'doc-hospital', 'doc-experience', 'doc-fee', 'doc-image', 'doc-bio'].forEach(id => {
    document.getElementById(id).value = '';
  });
}

// ─── UTILS ──────────────────────────────────────────
function safeSaveUser(user) {
  try {
    localStorage.setItem('mt_user', JSON.stringify(user));
  } catch (e) {
    if (e.name === 'QuotaExceededError' || e.code === 22) {
      console.warn('LocalStorage full, saving user without avatar');
      const smallUser = { ...user };
      delete smallUser.avatar;
      localStorage.setItem('mt_user', JSON.stringify(smallUser));
      showToast('Note: Profile photo too large to remember locally', 'info');
    } else {
      console.error('SafeSave failed:', e);
    }
  }
}

async function apiFetch(url, method = 'GET', body = null) {
  const opts = { method, headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  return fetch(url, opts);
}

function applyTheme(theme) {
  document.body.classList.toggle('dark', theme === 'dark');
  const btn = document.querySelector('.toggle-mode');
  if (btn) btn.textContent = theme === 'dark' ? '🌞' : '🌙';

  // Sync checkbox in settings if it exists
  const settingsToggle = document.getElementById('dark-mode-toggle-settings');
  if (settingsToggle) settingsToggle.checked = (theme === 'dark');

  localStorage.setItem('mt_theme', theme);
}

function toggleTheme() {
  const isDark = document.body.classList.contains('dark');
  applyTheme(isDark ? 'light' : 'dark');
}

function loadProfile() {
  if (!currentUser) return;

  const nameEl = document.getElementById('profile-name');
  const emailEl = document.getElementById('profile-email');
  const roleEl = document.getElementById('profile-role-text');

  if (nameEl) nameEl.textContent = currentUser.name;
  if (emailEl) emailEl.textContent = currentUser.email;
  if (roleEl) roleEl.textContent = (currentUser.role || 'User').toUpperCase();

  const settingsName = document.getElementById('profile-name-settings');
  const editName = document.getElementById('edit-name');
  const editEmail = document.getElementById('edit-email');
  const editBio = document.getElementById('edit-bio');
  const avatarImg = document.getElementById('profile-img-settings');
  const mfaToggle = document.getElementById('mfa-toggle');

  if (settingsName) settingsName.textContent = currentUser.name;
  if (editName) editName.value = currentUser.name;
  if (editEmail) editEmail.value = currentUser.email;
  if (editBio) editBio.value = currentUser.bio || '';
  if (avatarImg && currentUser.avatar) avatarImg.src = currentUser.avatar;

  // Update MFA Button/Text
  const mfaIcon = document.getElementById('mfa-status-icon');
  const mfaText = document.getElementById('mfa-status-text');
  if (mfaIcon && mfaText) {
    if (currentUser.mfaEnabled) {
      mfaIcon.textContent = '✅';
      mfaText.textContent = `MFA Active (${currentUser.mfaEmail})`;
    } else {
      mfaIcon.textContent = '🛡️';
      mfaText.textContent = 'Two-Factor Authentication';
    }
  }

  // Sync Private Account Button
  const paIcon = document.getElementById('pa-status-icon');
  const paText = document.getElementById('pa-status-text');
  const paBtn = document.getElementById('pa-toggle-btn');
  if (paIcon && paText && paBtn) {
    if (typeof isPrivateAccount !== 'undefined' && isPrivateAccount) {
      paIcon.textContent = '🔒';
      paText.textContent = 'Account is Private';
      paBtn.style.borderColor = 'var(--primary)';
    } else {
      paIcon.textContent = '🔓';
      paText.textContent = 'Make Account Private';
      paBtn.style.borderColor = 'rgba(255,255,255,0.1)';
    }
  }
}

async function uploadProfilePhoto(input) {
  if (input.files && input.files[0]) {
    const reader = new FileReader();
    reader.onload = async function (e) {
      const base64 = e.target.result;
      try {
        const res = await apiFetch('/api/user/profile', 'PATCH', { avatar: base64 });
        if (res.ok) {
          const data = await res.json();
          currentUser.avatar = base64;
          safeSaveUser(currentUser);
          document.getElementById('profile-img-settings').src = base64;
          showToast('Profile photo updated!', 'success');
        }
      } catch (err) {
        showToast('Photo upload failed', 'error');
      }
    };
    reader.readAsDataURL(input.files[0]);
  }
}

function toggleMfaForm(show) {
  const btn = document.getElementById('mfa-btn-container');
  const form = document.getElementById('mfa-form-container');
  const emailInput = document.getElementById('mfa-email');
  const actionBtn = document.getElementById('mfa-action-btn');

  if (show) {
    btn.style.display = 'none';
    form.style.display = 'block';

    if (currentUser.mfaEnabled) {
      emailInput.value = currentUser.mfaEmail || '';
      actionBtn.textContent = 'Disable MFA';
      actionBtn.className = 'btn btn-danger';
    } else {
      emailInput.value = currentUser.email || '';
      actionBtn.textContent = 'Enable MFA';
      actionBtn.className = 'btn btn-primary';
    }
  } else {
    btn.style.display = 'block';
    form.style.display = 'none';
    document.getElementById('mfa-error').textContent = '';
  }
}

async function confirmMfaToggle() {
  const mfaEmail = document.getElementById('mfa-email').value;
  const errEl = document.getElementById('mfa-error');
  errEl.textContent = '';

  try {
    const res = await apiFetch('/api/user/mfa/toggle', 'POST', { mfaEmail });
    const data = await res.json();

    if (res.ok) {
      currentUser.mfaEnabled = data.mfaEnabled;
      currentUser.mfaEmail = data.mfaEmail;
      safeSaveUser(currentUser);
      loadProfile(); // Updates icons/text
      toggleMfaForm(false);
      showToast(`MFA ${data.mfaEnabled ? 'Enabled' : 'Disabled'}!`, 'success');
    } else {
      errEl.textContent = data.message || 'MFA Update Failed';
    }
  } catch (err) {
    errEl.textContent = 'Connection error';
  }
}

let isPrivateAccount = false;
function togglePrivateAccount() {
  isPrivateAccount = !isPrivateAccount;
  const icon = document.getElementById('pa-status-icon');
  const text = document.getElementById('pa-status-text');
  const btn = document.getElementById('pa-toggle-btn');
  const container = btn.parentElement.parentElement;

  if (isPrivateAccount) {
    icon.textContent = '🔒';
    text.textContent = 'Account is Private';
    btn.style.borderColor = 'var(--primary)';
    container.style.opacity = '1';
    showToast('Account is now Private', 'info');
  } else {
    icon.textContent = '🔓';
    text.textContent = 'Make Account Private';
    btn.style.borderColor = 'rgba(255,255,255,0.1)';
    container.style.opacity = '0.8';
    showToast('Account is now Public', 'info');
  }
}

async function updateProfile() {
  const name = document.getElementById('edit-name').value;
  const bio = document.getElementById('edit-bio').value;
  try {
    const res = await apiFetch('/api/user/profile', 'PATCH', { name, bio });
    if (res.ok) {
      const data = await res.json();
      currentUser.name = name;
      currentUser.bio = bio;
      safeSaveUser(currentUser);
      loadProfile();
      showToast('Profile updated!', 'success');
    }
  } catch (err) {
    showToast('Update failed', 'error');
  }
}

async function changePassword() {
  const oldPassword = document.getElementById('cp-old-password').value;
  const newPassword = document.getElementById('cp-new-password').value;
  const confirmPassword = document.getElementById('cp-confirm-password').value;
  const errEl = document.getElementById('cp-error');
  errEl.textContent = '';

  if (!oldPassword || !newPassword || !confirmPassword) {
    errEl.textContent = 'All fields are required';
    return;
  }

  if (newPassword !== confirmPassword) {
    errEl.textContent = 'New passwords do not match';
    return;
  }

  if (newPassword.length < 6) {
    errEl.textContent = 'New password must be at least 6 characters';
    return;
  }

  try {
    const res = await apiFetch('/api/user/password', 'PATCH', { oldPassword, newPassword });
    const data = await res.json();
    if (res.ok) {
      showToast('Password updated successfully!', 'success');
      togglePasswordForm(false);
    } else {
      errEl.textContent = data.message || 'Update failed';
    }
  } catch (err) {
    errEl.textContent = 'Server connection failed';
  }
}

function togglePasswordForm(show) {
  const btn = document.getElementById('cp-btn-container');
  const form = document.getElementById('cp-form-container');
  if (show) {
    btn.style.display = 'none';
    form.style.display = 'block';
  } else {
    btn.style.display = 'block';
    form.style.display = 'none';
    // Clear fields
    document.getElementById('cp-old-password').value = '';
    document.getElementById('cp-new-password').value = '';
    document.getElementById('cp-confirm-password').value = '';
    document.getElementById('cp-error').textContent = '';
  }
}

function switchSettingTab(el, panelId) {
  // Update Sidebar
  document.querySelectorAll('.settings-nav li').forEach(li => li.classList.remove('active'));
  el.classList.add('active');

  // Update Panels
  document.querySelectorAll('.setting-panel').forEach(p => p.classList.remove('active'));
  const target = document.getElementById(`panel-${panelId}`);
  if (target) target.classList.add('active');
}

// ─── SETTINGS LOGIC ─────────────────────────────────

function showToast(msg, type = 'info') {
  const c = document.getElementById('toast-container');
  if (!c) return;
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  c.appendChild(t);
  // SMS/code toasts stay longer
  const duration = msg.includes('SMS') ? 8000 : 3000;
  setTimeout(() => t.remove(), duration);
}

// Modals
const availableSlots = ['09:00 AM', '10:00 AM', '11:00 AM', '01:00 PM', '02:00 PM', '03:00 PM', '04:00 PM'];

async function generateTimeSlots() {
  const container = document.getElementById('time-slots');
  const dateInput = document.getElementById('appointDate');
  const selectedDate = dateInput.value;
  document.getElementById('appointTime').value = '';

  // Set min date to today dynamically
  const today = new Date().toISOString().split('T')[0];
  if (!dateInput.min) dateInput.min = today;

  if (!selectedDate) {
    container.innerHTML = '<div style="opacity: 0.6; font-size: 0.9em;">Select a date first</div>';
    return;
  }

  try {
    // Fetch counts for this doctor and date
    const res = await apiFetch(`/api/appointments/availability?doctorId=${selectedDoctorId}&date=${selectedDate}`);
    const bookedCounts = await res.json();

    // Check current time if selectedDate is today
    const now = new Date();
    const isToday = selectedDate === today;

    const filteredSlots = availableSlots.filter(slot => {
      // Rule 1: Limit 4 members (Only show if < 4)
      const isFull = (bookedCounts[slot] || 0) >= 4;
      if (isFull) return false;

      // Rule 2: Real-time date and time (Remove's past slots for today)
      if (isToday) {
        const [time, period] = slot.split(' ');
        let [hour, minute] = time.split(':').map(Number);
        if (period === 'PM' && hour < 12) hour += 12;
        if (period === 'AM' && hour === 12) hour = 0;

        const slotDate = new Date();
        slotDate.setHours(hour, minute, 0, 0);
        return slotDate > now;
      }

      return true;
    });

    if (filteredSlots.length === 0) {
      container.innerHTML = '<div style="opacity: 0.6; font-size: 0.9em; grid-column: span 2; padding: 10px;">No slots available for this date.</div>';
      return;
    }

    container.innerHTML = filteredSlots.map(slot => `
      <button class="slot-btn" onclick="selectSlot(this, '${slot}')" style="background: var(--secondary); color: var(--text); border: 1px solid rgba(0,0,0,0.1); padding: 8px; border-radius: 8px; cursor: pointer; transition: 0.2s;">
        ${slot} ${bookedCounts[slot] ? `<span style="font-size:0.7em; opacity:0.6;">(${bookedCounts[slot]}/4)</span>` : ''}
      </button>
    `).join('');

  } catch (err) {
    console.error('Failed to get slot availability:', err);
    container.innerHTML = '<div style="color: var(--danger); font-size: 0.8em;">Error checking slots.</div>';
  }
}

function selectSlot(btnElement, timeStr) {
  document.querySelectorAll('.slot-btn').forEach(btn => {
    btn.style.background = 'var(--secondary)';
    btn.style.color = 'var(--text)';
    btn.style.borderColor = 'rgba(0,0,0,0.1)';
  });
  btnElement.style.background = 'var(--primary)';
  btnElement.style.color = 'white';
  btnElement.style.borderColor = 'var(--primary)';
  document.getElementById('appointTime').value = timeStr;
}

function goToBookingStep(step) {
  // Validate Step 1 before moving to 2
  if (step === 2) {
    const date = document.getElementById('appointDate').value;
    const time = document.getElementById('appointTime').value;
    if (!date || !time) return showToast('Please select date and time', 'error');
  }
  // Validate Step 2 before moving to 3
  if (step === 3) {
    const phone = document.getElementById('book-phone').value.trim();
    const email = document.getElementById('book-email').value.trim();
    if (!phone || !email) return showToast('Please enter phone and email', 'error');
  }

  document.querySelectorAll('.booking-step').forEach(el => el.classList.add('hidden'));
  document.getElementById(`booking-step-${step}`).classList.remove('hidden');
}

let selectedDoctorFee = 500;

function openBooking(id, name) {
  selectedDoctorId = id;
  const doctor = doctors.find(d => d._id === id);
  selectedDoctorFee = doctor ? (doctor.fee || 500) : 500;

  document.getElementById('book-doc-name').textContent = `Book with ${name} (₹${selectedDoctorFee})`;
  document.getElementById('appointDate').value = '';
  document.getElementById('appointTime').value = '';
  document.getElementById('book-phone').value = '';
  document.getElementById('book-email').value = currentUser.email || '';
  generateTimeSlots();
  goToBookingStep(1);
  document.getElementById('calendarModal').classList.add('active');
}
function closeModal(id) { document.getElementById(id).classList.remove('active'); }

async function addMedicine() {
  const name = document.getElementById('medName').value;
  const time = document.getElementById('medTime').value;
  await apiFetch('/api/medicines', 'POST', { name, dosage: '1 dose', time });
  document.getElementById('medName').value = '';
  document.getElementById('medTime').value = '';
}

async function toggleStatus(id) {
  await apiFetch(`/api/medicines/${id}/status`, 'PATCH');
}

function proceedToFinalPayment() {
  const paymentMethod = document.querySelector('input[name="paymentType"]:checked').value;
  if (paymentMethod === 'UPI') {
    goToBookingStep(4);
  } else {
    // For cards, we could add a card step, but for now we skip to final
    bookAppointment();
  }
}

function generatePaymentQR() {
  const paymentMethod = document.querySelector('input[name="paymentType"]:checked').value;

  if (paymentMethod === 'UPI') {
    const amount = selectedDoctorFee || 500;
    // Set a placeholder Paytm-like UPI ID
    const upiID = "paytmqr281005051011116234@paytm";
    const upiName = "MediTrack Healthcare";
    const upiLink = `upi://pay?pa=${upiID}&pn=${encodeURIComponent(upiName)}&am=${amount}&cu=INR`;

    const qrContainer = document.getElementById('qrcode-container');
    qrContainer.innerHTML = "";

    new QRCode(qrContainer, {
      text: upiLink,
      width: 180,
      height: 180,
      colorDark: "#003b71", // Paytm Dark Blue
      colorLight: "#ffffff",
      correctLevel: QRCode.CorrectLevel.H
    });

    document.getElementById('upi-transaction-id').value = '';
    goToBookingStep(4);
  } else {
    bookAppointment();
  }
}

async function bookAppointment() {
  const date = document.getElementById('appointDate').value;
  const time = document.getElementById('appointTime').value;
  const phone = document.getElementById('book-phone').value;
  const email = document.getElementById('book-email').value;
  const paymentMethod = document.querySelector('input[name="paymentType"]:checked').value;
  let transactionId = document.getElementById('upi-transaction-id')?.value || '';

  if (transactionId === 'AUTO_DETECTED') {
    // Generate a futuristic looking transaction ID automatically
    transactionId = 'TXN' + Date.now().toString().slice(-8) + Math.floor(Math.random() * 100);
  }

  // Switch to Verifying Step
  goToBookingStep(5);
  const statusEl = document.getElementById('verification-status');

  // Automated Detection Sequence
  setTimeout(() => statusEl.textContent = "Listening for incoming UPI transfers...", 800);
  setTimeout(() => statusEl.textContent = "Matching transaction from account ending in ***" + phone.slice(-4), 1600);
  setTimeout(() => statusEl.textContent = "Transfer recognized! Finalizing booking... ✅", 2400);

  setTimeout(async () => {
    try {
      const res = await apiFetch('/api/appointments', 'POST', {
        doctorId: selectedDoctorId,
        date,
        time,
        phone,
        email,
        paymentMethod,
        transactionId,
        amount: selectedDoctorFee
      });

      const data = await res.json();
      if (res.ok) {
        closeModal('calendarModal');
        const doc = doctors.find(d => d._id === selectedDoctorId);
        showReceipt(data, doc ? doc.name : 'Consultant');
        showToast('✅ Payment Detected & Confirmed!', 'success');
        if (currentUser.role === 'user') fetchNotifications();
      } else {
        goToBookingStep(4);
        showToast(data.message || 'Verification failed', 'error');
      }
    } catch (e) {
      goToBookingStep(4);
      showToast('Cloud connection error. Try again.', 'error');
    }
  }, 3000);
}

function showReceipt(apt, doctorName) {
  document.getElementById('r-txn-id').textContent = apt.transactionId || 'MTK' + Math.floor(Math.random() * 1000000);
  document.getElementById('r-patient-name').textContent = currentUser.name;
  document.getElementById('r-doctor-name').textContent = doctorName;
  document.getElementById('r-date').textContent = apt.date;
  document.getElementById('r-time').textContent = apt.time;
  document.getElementById('r-amount').textContent = '₹' + (apt.amount || 500) + '.00';

  document.getElementById('receiptModal').classList.add('active');
}

async function fetchNotifications() {
  try {
    const res = await apiFetch('/api/notifications');
    const data = await res.json();
    if (Array.isArray(data)) {
      notifications = data;
      renderNotifications();
    }
  } catch (e) { console.error('Notifications fetch error:', e); }
}

function renderNotifications() {
  const el = document.getElementById('notifications-list');
  if (!el || !Array.isArray(notifications)) return;
  el.innerHTML = notifications.length ? notifications.map(n => `
    <div class="notification-item" style="display: flex; justify-content: space-between; align-items: flex-start; gap: 15px; position: relative;">
      <div style="flex: 1;">
        ✅ <b>${n.message}</b><br><small>${new Date(n.timestamp).toLocaleTimeString()}</small>
      </div>
      <button onclick="deleteNotification('${n._id}')" style="background: none; border: none; color: #ff4d4d; cursor: pointer; opacity: 0.6; font-size: 1.1rem; padding: 0 5px;" title="Delete">&times;</button>
    </div>
  `).join('') : '<p style="text-align:center;opacity:0.6;">No new notifications</p>';
}

async function deleteNotification(id) {
  try {
    const res = await apiFetch(`/api/notifications/${id}`, 'DELETE');
    if (res.ok) {
      notifications = notifications.filter(n => n._id !== id);
      renderNotifications();
      showToast('Notification deleted', 'info');
    }
  } catch (e) { console.error('Delete notification error:', e); }
}

async function clearAllNotifications() {
  if (!confirm('Clear all notifications?')) return;
  try {
    const res = await apiFetch('/api/notifications', 'DELETE');
    if (res.ok) {
      notifications = [];
      renderNotifications();
      showToast('All notifications cleared', 'success');
    }
  } catch (e) { console.error('Clear notifications error:', e); }
}


