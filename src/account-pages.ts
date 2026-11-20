import type { Express } from 'express';

const emailField = '<label>Email<input name="email" type="email" autocomplete="email" required></label>';
const passwordField = (name: string, label: string, autocomplete: string) =>
  `<label>${label}<input name="${name}" type="password" autocomplete="${autocomplete}" maxlength="128" required></label>`;
const nameField = '<label>Display name<input name="name" autocomplete="nickname" maxlength="120" required></label>';

function form(endpoint: string, fields: string, button: string) {
  return `<form method="post" action="/api/auth/${endpoint}">${fields}<button>${button}</button></form>`;
}

export function page(title: string, content: string, script = false) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} | GIS Platform</title>
<style>
  body{margin:0;background:#f4f6f5;color:#172822;font:1rem system-ui,sans-serif}
  main{max-width:36rem;margin:3rem auto;padding:0 1.25rem}
  nav{display:flex;gap:1rem;flex-wrap:wrap;margin-bottom:2rem} a{color:#215e4e}
  form,label{display:grid;gap:.5rem} form{max-width:24rem;gap:1rem}
  input,button{font:inherit;padding:.6rem;border:1px solid #74847f;border-radius:.25rem}
  button{justify-self:start;color:white;background:#245344;border-color:#245344;cursor:pointer}
  [role=status]{min-height:1.5em}
</style></head>
<body><main><nav aria-label="Platform"><a href="/features">Features</a><a href="/account/login">Sign in</a><a href="/account/register">Register</a><a href="/account/profile">Profile</a></nav>
<h1>${title}</h1>${content}${script ? '<p role="status" aria-live="polite"></p><noscript>Enable JavaScript to submit this form.</noscript><script type="module" src="/account/form.js"></script>' : ''}
</main></body></html>`;
}

const formScript = `
const status = document.querySelector('[role=status]');
const profile = document.querySelector('form[action="/api/auth/update-user"]');
if (profile) {
  fetch('/api/auth/get-session').then(async (response) => {
    if (!response.ok) throw new Error();
    const session = await response.json();
    if (!session) return location.assign('/account/login');
    profile.elements.namedItem('name').value = session.user.name;
    document.querySelector('#profile-email').textContent = session.user.email;
  }).catch(() => { status.textContent = 'The service is temporarily unavailable.'; });
}
for (const form of document.querySelectorAll('form')) form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true;
  status.textContent = '';
  try {
    const body = Object.fromEntries(new FormData(form));
    if (form.action.endsWith('/reset-password')) body.token = new URL(location.href).searchParams.get('token');
    const response = await fetch(form.action, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      status.textContent = error.message || 'Request failed. Try again.';
      return;
    }
    if (form.action.endsWith('/sign-in/email')) location.assign('/features/collections');
    else if (form.action.endsWith('/update-user')) status.textContent = 'Display name updated.';
    else if (form.action.endsWith('/sign-out')) location.assign('/account/login');
    else if (form.action.endsWith('/change-password')) location.assign('/account/profile');
    else if (form.action.endsWith('/reset-password')) location.assign('/account/login');
    else if (form.action.endsWith('/request-password-reset')) {
      status.textContent = 'If the address is eligible, we sent a password reset link.';
    }
    else location.assign('/account/check-email');
  } catch {
    status.textContent = 'The service is temporarily unavailable.';
  } finally {
    button.disabled = false;
  }
});
`;

export function mountAccountPages(app: Express) {
  app.use('/account', (_req, res, next) => {
    res.set('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    res.set('Referrer-Policy', 'no-referrer');
    next();
  });
  app.get('/account', (_req, res) => res.redirect('/account/login'));
  app.get('/account/register', (_req, res) => res.send(page('Register', form('sign-up/email',
    nameField + emailField + passwordField('password', 'Password', 'new-password'), 'Create account'), true)));
  app.get('/account/login', (_req, res) => res.send(page('Sign in', form('sign-in/email',
    emailField + passwordField('password', 'Password', 'current-password'), 'Sign in') +
    '<p><a href="/account/forgot-password">Forgot password?</a></p>', true)));
  app.get('/account/check-email', (_req, res) => res.send(page('Check your email',
    '<p>If the address is eligible, we sent a link to confirm it.</p>')));
  app.get('/account/verified', (req, res) => res.send(req.query.error
    ? page('Verification failed', '<p>Sign in to request a fresh verification link.</p>')
    : page('Email is verified', '<p><a href="/account/login">Sign in to continue</a>.</p>')));
  app.get('/account/profile', (_req, res) => res.send(page('Profile',
    '<p id="profile-email"></p>' + form('update-user', nameField, 'Save name') +
    '<p><a href="/account/change-password">Change password</a></p>' + form('sign-out', '', 'Sign out'), true)));
  app.get('/account/change-password', (_req, res) => res.send(page('Change password', form('change-password',
    passwordField('currentPassword', 'Current password', 'current-password') +
    passwordField('newPassword', 'New password', 'new-password'), 'Change password'), true)));
  app.get('/account/forgot-password', (_req, res) => res.send(page('Reset your password',
    form('request-password-reset', emailField, 'Send reset link'), true)));
  app.get('/account/reset-password', (req, res) => res.send(typeof req.query.token === 'string' && req.query.token
    ? page('Choose a new password', form('reset-password',
      passwordField('newPassword', 'New password', 'new-password'), 'Save password'), true)
    : page('Reset link required', '<p><a href="/account/forgot-password">Request a password reset link</a>.</p>')));
  app.get('/account/form.js', (_req, res) => res.type('js').send(formScript));
}
