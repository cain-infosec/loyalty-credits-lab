// Shared helpers for the Loyalty Credits Lab frontend.
const API = '/api/loyalty/v1';

function saveSession(data) {
  localStorage.setItem('lab_token', data.access_token);
  localStorage.setItem('lab_wallet', data.wallet_id);
  localStorage.setItem('lab_name', data.full_name);
  localStorage.setItem('lab_client_key', data.client_key);
}

function token() { return localStorage.getItem('lab_token'); }
function clientKey() { return localStorage.getItem('lab_client_key'); }

function logout() {
  localStorage.clear();
  location.href = '/index.html';
}

function requireAuth() {
  if (!token()) location.href = '/index.html';
}

async function api(path, { method = 'GET', body, extraHeaders = {} } = {}) {
  const headers = { 'Content-Type': 'application/json', ...extraHeaders };
  if (token()) headers['Authorization'] = `Bearer ${token()}`;
  const res = await fetch(API + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* html or empty */ }
  return { ok: res.ok, status: res.status, data };
}
