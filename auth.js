(() => {
  const $ = selector => document.querySelector(selector);
  const form = $('#auth-form');
  let mode = window.location.pathname === '/register' ? 'register' : 'login';

  function setMode(nextMode, updateUrl = true) {
    mode = nextMode;
    const registering = mode === 'register';
    $('#name-field').classList.toggle('hidden', !registering);
    $('#confirm-field').classList.toggle('hidden', !registering);
    $('#name').required = registering;
    $('#confirm-password').required = registering;
    $('#password').autocomplete = registering ? 'new-password' : 'current-password';
    $('#login-tab').classList.toggle('active', !registering);
    $('#register-tab').classList.toggle('active', registering);
    $('#login-tab').setAttribute('aria-selected', String(!registering));
    $('#register-tab').setAttribute('aria-selected', String(registering));
    $('#form-title').textContent = registering ? 'Create your account' : 'Welcome back';
    $('#form-subtitle').textContent = registering ? 'Create an account to access your vehicle dashboard.' : 'Sign in to view vehicle status and incident records.';
    $('#submit-button').textContent = registering ? 'Create account' : 'Sign in';
    const configured = ['apiKey', 'authDomain', 'databaseURL', 'projectId', 'appId'].every(key => window.VTAAS_FIREBASE_CONFIG?.[key]?.trim());
    $('#auth-note').textContent = configured
      ? 'Your account is protected by Firebase Authentication.'
      : 'Local prototype accounts are stored on the computer running the dashboard.';
    $('#auth-error').textContent = '';
    if (updateUrl) history.replaceState(null, '', registering ? '/register' : '/login');
  }

  $('#login-tab').addEventListener('click', () => setMode('login'));
  $('#register-tab').addEventListener('click', () => setMode('register'));
  window.addEventListener('popstate', () => setMode(window.location.pathname === '/register' ? 'register' : 'login', false));

  form.addEventListener('submit', async event => {
    event.preventDefault();
    $('#auth-error').textContent = '';
    const email = $('#email').value.trim();
    const password = $('#password').value;
    if (!email || password.length < 8) { $('#auth-error').textContent = 'Enter your email and a password with at least 8 characters.'; return; }
    if (mode === 'register') {
      if ($('#name').value.trim().length < 2) { $('#auth-error').textContent = 'Enter your name (at least 2 characters).'; return; }
      if ($('#confirm-password').value !== password) { $('#auth-error').textContent = 'The passwords do not match.'; return; }
    }
    const button = $('#submit-button');
    button.disabled = true;
    button.textContent = mode === 'register' ? 'Creating account…' : 'Signing in…';
    try {
      const firebase = await (window.vtaasFirebaseReady || Promise.resolve(null));
      if (firebase) {
        if (mode === 'register') await firebase.register($('#name').value.trim(), email, password);
        else await firebase.login(email, password);
        window.location.replace('/');
        return;
      }
      const response = await fetch(`/api/auth/${mode}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: $('#name').value.trim(), email, password })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not sign in. Try again.');
      window.location.replace('/');
    } catch (error) {
      const firebaseMessages = {
        'auth/email-already-in-use': 'An account already exists for this email. Sign in instead.',
        'auth/invalid-email': 'Enter a valid email address.',
        'auth/invalid-credential': 'Email or password is incorrect.',
        'auth/weak-password': 'Enter a password with at least 8 characters.',
        'auth/operation-not-allowed': 'Enable Email/Password sign-in in Firebase Authentication settings.',
        'auth/network-request-failed': 'Could not reach Firebase. Check the internet connection.'
      };
      $('#auth-error').textContent = firebaseMessages[error.code] || error.message || 'The server could not be reached. Check that the dashboard server is running.';
    } finally {
      button.disabled = false;
      button.textContent = mode === 'register' ? 'Create account' : 'Sign in';
    }
  });

  (async () => {
    const firebase = await (window.vtaasFirebaseReady || Promise.resolve(null));
    if (firebase) {
      $('#auth-note').textContent = 'Your account is protected by Firebase Authentication.';
      firebase.onAuthStateChanged(user => { if (user) window.location.replace('/'); });
      return;
    }
    $('#auth-note').textContent = 'Local prototype accounts are stored on the computer running the dashboard.';
    fetch('/api/auth/session', { cache: 'no-store' }).then(response => {
      if (response.ok) window.location.replace('/');
    }).catch(() => {});
  })();
  setMode(mode, false);
})();
