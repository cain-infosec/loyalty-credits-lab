'use strict';

/*
 * Loyalty Credits Lab - backend
 *
 * A minimal loyalty-credits service: sign in, check your balance, and transfer
 * credits to another member through a confirmation link delivered to your
 * in-app inbox.
 *
 * Zero external dependencies: Node built-ins only
 * (node:http, node:sqlite, node:crypto). Run with:
 *   node --experimental-sqlite server.js
 *
 * Write-up: https://blog.cain.tech
 */

const http = require('node:http');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DB_PATH || '/data/lab.db';

// Global client key required by the transfer endpoint.
const CLIENT_KEY = process.env.CLIENT_KEY || '9f2c1a7e4b8d4c0fae31b6d902c5e7a1';

// Confirmation links stay valid for 24h.
const CONFIRM_TTL_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Database bootstrap
// ---------------------------------------------------------------------------

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id            INTEGER PRIMARY KEY,
    email         TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    full_name     TEXT NOT NULL,
    wallet_id     TEXT UNIQUE NOT NULL,
    card_ref      TEXT NOT NULL,
    balance       INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    account_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS transfers (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    confirm_token      TEXT UNIQUE NOT NULL,
    sender_id          INTEGER NOT NULL,
    recipient_email    TEXT NOT NULL,
    recipient_wallet   TEXT,
    recipient_card_ref TEXT,
    locale             TEXT,
    credits            INTEGER NOT NULL,
    state              TEXT NOT NULL,      -- pending | confirmed | expired
    created_at         INTEGER NOT NULL,
    confirmed_at       INTEGER
  );
`);

function hashPassword(password, salt) {
  const useSalt = salt || crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, useSalt, 32).toString('hex');
  return `${useSalt}:${derived}`;
}

function verifyPassword(password, stored) {
  const [salt] = stored.split(':');
  if (!salt) return false;
  const candidate = hashPassword(password, salt);
  const a = Buffer.from(candidate);
  const b = Buffer.from(stored);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Two fixed accounts, provisioned on first boot.
const SEED_ACCOUNTS = [
  {
    email: 'sender@lab.local',
    password: 'Sender#2026',
    full_name: 'Sender',
    wallet_id: 'WALLET-1001',
    card_ref: 'CARD-1001',
    balance: 5,
  },
  {
    email: 'receiver@lab.local',
    password: 'Receiver#2026',
    full_name: 'Receiver',
    wallet_id: 'WALLET-1002',
    card_ref: 'CARD-1002',
    balance: 5,
  },
];

function seedAccounts() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n;
  if (count > 0) return;
  const insert = db.prepare(
    `INSERT INTO accounts (email, password_hash, full_name, wallet_id, card_ref, balance)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const a of SEED_ACCOUNTS) {
    insert.run(a.email, hashPassword(a.password), a.full_name, a.wallet_id, a.card_ref, a.balance);
  }
  console.log('[seed] provisioned fixed accounts:', SEED_ACCOUNTS.map((a) => a.email).join(', '));
}

function resetLab() {
  // Keep active sessions so a logged-in user is not kicked out on reset.
  db.exec('DELETE FROM transfers;');
  const update = db.prepare('UPDATE accounts SET balance = ? WHERE email = ?');
  for (const a of SEED_ACCOUNTS) update.run(a.balance, a.email);
}

// Keep the fixed accounts' profile fields in sync with SEED_ACCOUNTS on every
// boot (names, wallet/card ids) without touching balances, so a redeploy over
// an existing volume never keeps stale profile data.
function ensureAccountProfiles() {
  const update = db.prepare(
    'UPDATE accounts SET full_name = ?, wallet_id = ?, card_ref = ? WHERE email = ?'
  );
  for (const a of SEED_ACCOUNTS) update.run(a.full_name, a.wallet_id, a.card_ref, a.email);
}

seedAccounts();
ensureAccountProfiles();

// ---------------------------------------------------------------------------
// Small HTTP helpers
// ---------------------------------------------------------------------------

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Client-Key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(body);
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) req.destroy();
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(null); // signal malformed JSON
      }
    });
  });
}

function getAuthAccount(req) {
  const header = req.headers['authorization'] || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return null;
  const session = db.prepare('SELECT account_id FROM sessions WHERE token = ?').get(match[1]);
  if (!session) return null;
  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(session.account_id) || null;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

// POST /api/loyalty/v1/auth/session
async function handleLogin(req, res) {
  const body = await readJsonBody(req);
  if (!body) return sendJson(res, 400, { error: 'malformed_json' });
  const { email, password } = body;
  const account = db.prepare('SELECT * FROM accounts WHERE email = ?').get(String(email || ''));
  if (!account || !verifyPassword(String(password || ''), account.password_hash)) {
    return sendJson(res, 401, { error: 'invalid_credentials' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions (token, account_id, created_at) VALUES (?, ?, ?)')
    .run(token, account.id, Date.now());
  return sendJson(res, 200, {
    access_token: token,
    wallet_id: account.wallet_id,
    full_name: account.full_name,
    client_key: CLIENT_KEY, // exposed here only to make the lab easy to drive
  });
}

// GET /api/loyalty/v1/wallet/me
function handleWalletMe(req, res) {
  const account = getAuthAccount(req);
  if (!account) return sendJson(res, 401, { error: 'unauthorized' });
  return sendJson(res, 200, {
    email: account.email,
    full_name: account.full_name,
    wallet_id: account.wallet_id,
    card_ref: account.card_ref,
    credit_balance: account.balance,
  });
}

// POST /api/loyalty/v1/wallet/transfer-credits
//
// Body:
//   recipient_wallet_id, recipient_email, locale, recipient_card_ref, credits
async function handleTransferCreate(req, res) {
  const account = getAuthAccount(req);
  if (!account) return sendJson(res, 401, { error: 'unauthorized' });

  if ((req.headers['x-client-key'] || '') !== CLIENT_KEY) {
    return sendJson(res, 401, { error: 'invalid_client_key' });
  }

  const body = await readJsonBody(req);
  if (!body) return sendJson(res, 400, { error: 'malformed_json' });

  const credits = Number.parseInt(body.credits, 10);
  const recipientEmail = String(body.recipient_email || '').trim();

  if (!recipientEmail) return sendJson(res, 400, { error: 'recipient_email_required' });
  if (!Number.isInteger(credits) || credits <= 0) {
    return sendJson(res, 400, { error: 'credits_must_be_positive_integer' });
  }

  if (credits > account.balance) {
    return sendJson(res, 422, { error: 'insufficient_credits' });
  }
  // Balance is validated but not reserved or deducted at this point.

  const confirmToken = crypto.randomBytes(16).toString('hex');
  db.prepare(
    `INSERT INTO transfers
       (confirm_token, sender_id, recipient_email, recipient_wallet, recipient_card_ref, locale, credits, state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
  ).run(
    confirmToken,
    account.id,
    recipientEmail,
    String(body.recipient_wallet_id || ''),
    String(body.recipient_card_ref || ''),
    String(body.locale || 'en'),
    credits,
    Date.now()
  );

  // The confirmation link is delivered to the sender's in-app inbox (GET /inbox).
  console.log(`[mail] -> ${account.email}: confirm token ${confirmToken} (${credits} credits to ${recipientEmail})`);

  return sendJson(res, 200, {
    state: 'awaiting_confirmation',
    message: 'Check your inbox to approve and finalize the credit transfer.',
  });
}

// GET /api/loyalty/v1/inbox  -> in-app inbox of the logged-in sender
function handleInbox(req, res) {
  const account = getAuthAccount(req);
  if (!account) return sendJson(res, 401, { error: 'unauthorized' });
  const rows = db.prepare(
    `SELECT confirm_token, recipient_email, credits, state, created_at, confirmed_at
       FROM transfers WHERE sender_id = ? ORDER BY id DESC`
  ).all(account.id);
  const messages = rows.map((r) => ({
    subject:
      r.state === 'confirmed'
        ? `You transferred ${r.credits} credits`
        : `Confirm your ${r.credits}-credit transfer`,
    recipient_email: r.recipient_email,
    credits: r.credits,
    state: r.state,
    created_at: r.created_at,
    confirmed_at: r.confirmed_at,
    confirm_url: `/api/loyalty/v1/wallet/transfer-credits/confirm?token=${r.confirm_token}`,
  }));
  return sendJson(res, 200, { inbox_owner: account.email, messages });
}

// GET /api/loyalty/v1/wallet/transfer-credits/confirm?token=...
// Confirmation link delivered to the sender's inbox; finalizes the transfer.
function handleConfirm(req, res, url) {
  const confirmToken = url.searchParams.get('token') || '';
  const transfer = db.prepare('SELECT * FROM transfers WHERE confirm_token = ?').get(confirmToken);

  if (!transfer) {
    return sendHtml(res, 404, confirmPage('Invalid link', 'This confirmation link is not valid.', false));
  }
  if (transfer.state === 'confirmed') {
    return sendHtml(res, 200, confirmPage('Already confirmed', 'This transfer has already been completed.', true));
  }
  if (Date.now() - transfer.created_at > CONFIRM_TTL_MS) {
    db.prepare("UPDATE transfers SET state = 'expired' WHERE id = ?").run(transfer.id);
    return sendHtml(res, 410, confirmPage('Link expired', 'This confirmation link has expired.', false));
  }

  const sender = db.prepare('SELECT * FROM accounts WHERE id = ?').get(transfer.sender_id);
  const recipient = db.prepare('SELECT * FROM accounts WHERE email = ?').get(transfer.recipient_email);

  // Recipient is credited; sender is debited with a floor at 0.
  if (recipient) {
    db.prepare('UPDATE accounts SET balance = balance + ? WHERE id = ?')
      .run(transfer.credits, recipient.id);
  }
  const newSenderBalance = Math.max(0, sender.balance - transfer.credits);
  db.prepare('UPDATE accounts SET balance = ? WHERE id = ?').run(newSenderBalance, sender.id);

  db.prepare("UPDATE transfers SET state = 'confirmed', confirmed_at = ? WHERE id = ?")
    .run(Date.now(), transfer.id);

  console.log(
    `[confirm] token ${confirmToken}: +${transfer.credits} to ${transfer.recipient_email}; ` +
      `sender ${sender.email} now ${newSenderBalance}`
  );

  return sendHtml(
    res,
    200,
    confirmPage(
      'Transfer confirmed',
      `${transfer.credits} credits were transferred to ${transfer.recipient_email}.`,
      true
    )
  );
}

// GET /api/loyalty/v1/lab/state  -> convenience read-only view of both wallets
function handleLabState(req, res) {
  const rows = db.prepare('SELECT email, full_name, balance FROM accounts ORDER BY id').all();
  const pending = db.prepare("SELECT COUNT(*) AS n FROM transfers WHERE state = 'pending'").get().n;
  const confirmed = db.prepare("SELECT COUNT(*) AS n FROM transfers WHERE state = 'confirmed'").get().n;
  return sendJson(res, 200, { accounts: rows, pending_transfers: pending, confirmed_transfers: confirmed });
}

// POST /api/loyalty/v1/lab/reset  -> restore initial state
function handleLabReset(req, res) {
  resetLab();
  return sendJson(res, 200, { message: 'Lab reset. Both accounts hold 5 credits again.' });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function confirmPage(title, detail, ok) {
  const color = ok ? '#1a7f37' : '#b42318';
  const icon = ok ? '&#10004;' : '&#10007;';
  const safeTitle = escapeHtml(title);
  const safeDetail = escapeHtml(detail);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>
  body{font-family:system-ui,Segoe UI,Roboto,sans-serif;background:#f4f6f8;margin:0;
       display:flex;min-height:100vh;align-items:center;justify-content:center}
  .card{background:#fff;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.08);
        padding:40px;max-width:420px;text-align:center}
  .badge{font-size:44px;color:${color}}
  h1{font-size:20px;margin:12px 0}
  p{color:#475467;line-height:1.5}
  a{display:inline-block;margin-top:18px;color:#1570ef;text-decoration:none;font-weight:600}
</style></head><body>
  <div class="card">
    <div class="badge">${icon}</div>
    <h1>${safeTitle}</h1>
    <p>${safeDetail}</p>
    <a href="/inbox.html">&#8592; Back to inbox</a>
  </div>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;
  const method = req.method || 'GET';

  if (method === 'OPTIONS') return sendJson(res, 204, {});

  try {
    if (method === 'POST' && path === '/api/loyalty/v1/auth/session') return await handleLogin(req, res);
    if (method === 'GET' && path === '/api/loyalty/v1/wallet/me') return handleWalletMe(req, res);
    if (method === 'POST' && path === '/api/loyalty/v1/wallet/transfer-credits') return await handleTransferCreate(req, res);
    if (method === 'GET' && path === '/api/loyalty/v1/wallet/transfer-credits/confirm') return handleConfirm(req, res, url);
    if (method === 'GET' && path === '/api/loyalty/v1/inbox') return handleInbox(req, res);
    if (method === 'GET' && path === '/api/loyalty/v1/lab/state') return handleLabState(req, res);
    if (method === 'POST' && path === '/api/loyalty/v1/lab/reset') return handleLabReset(req, res);

    return sendJson(res, 404, { error: 'not_found' });
  } catch (err) {
    console.error('[error]', err);
    return sendJson(res, 500, { error: 'internal_error' });
  }
});

server.listen(PORT, () => {
  console.log(`[loyalty-lab] backend listening on :${PORT} (db: ${DB_PATH})`);
});
