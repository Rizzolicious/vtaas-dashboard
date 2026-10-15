'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { WebSocketServer, WebSocket } = require('ws');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8080);
const ROOT = __dirname;
const firebaseConfigSource = (() => { try { return fs.readFileSync(path.join(ROOT, 'firebase-config.js'), 'utf8'); } catch { return ''; } })();
const FIREBASE_AUTH_CONFIGURED = ['apiKey', 'authDomain', 'databaseURL', 'projectId', 'appId'].every(key => new RegExp(`${key}:\\s*[\"'][^\"']+[\"']`).test(firebaseConfigSource));
const MAX_BODY_BYTES = 64 * 1024;
const EVENT_DATA_DIR = path.resolve(process.env.VT_AAS_DATA_DIR || path.join(ROOT, 'data'));
const EVENT_STORE_PATH = path.join(EVENT_DATA_DIR, 'relay-events.json');
const USER_STORE_PATH = path.join(EVENT_DATA_DIR, 'users.json');
const MAX_STORED_EVENTS = 300;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const scrypt = promisify(crypto.scrypt);
const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const bufferedEvents = new Map();
const users = [];
const sessions = new Map();
const pendingRegistrationEmails = new Set();
const authAttempts = new Map();
let eventWriteQueue = Promise.resolve();
let userWriteQueue = Promise.resolve();

try {
  const saved = JSON.parse(fs.readFileSync(EVENT_STORE_PATH, 'utf8'));
  if (Array.isArray(saved)) saved.slice(-MAX_STORED_EVENTS).forEach(event => {
    if (event && event.event_id && event.payload && typeof event.payload === 'object') bufferedEvents.set(String(event.event_id), event.payload);
  });
} catch (error) {
  if (error.code !== 'ENOENT') console.warn(`Could not read buffered events: ${error.message}`);
}

try {
  const savedUsers = JSON.parse(fs.readFileSync(USER_STORE_PATH, 'utf8'));
  if (!Array.isArray(savedUsers)) throw new Error('Expected an array of users.');
  savedUsers.filter(user => user && user.id && user.email && user.password_hash && user.password_salt).forEach(user => users.push(user));
} catch (error) {
  if (error.code !== 'ENOENT') console.warn(`Could not read account store: ${error.message}`);
}

function sessionKeyFromRequest(req) {
  const cookie = String(req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith('vtaas_session='));
  if (!cookie) return null;
  const token = cookie.slice('vtaas_session='.length);
  return crypto.createHash('sha256').update(token).digest('hex');
}

function sessionFromRequest(req) {
  const key = sessionKeyFromRequest(req);
  if (!key) return null;
  const session = sessions.get(key);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) { sessions.delete(key); return null; }
  return users.find(user => user.id === session.userId) || null;
}

function publicUser(user) { return { id: user.id, name: user.name, email: user.email }; }

function setSession(res, req, user) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.set(crypto.createHash('sha256').update(token).digest('hex'), { userId: user.id, expiresAt });
  const secure = req.socket.encrypted ? '; Secure' : '';
  res.setHeader('set-cookie', `vtaas_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`);
}

function clearSessionCookie(res, req) {
  const secure = req.socket.encrypted ? '; Secure' : '';
  res.setHeader('set-cookie', `vtaas_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`);
}

function sameOrigin(req) {
  if (!req.headers.origin) return true;
  try { return new URL(req.headers.origin).host === req.headers.host; } catch { return false; }
}

function consumeAuthAttempt(req) {
  const key = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const recent = (authAttempts.get(key) || []).filter(timestamp => now - timestamp < 10 * 60 * 1000);
  if (recent.length >= 10) { authAttempts.set(key, recent); return false; }
  recent.push(now); authAttempts.set(key, recent);
  return true;
}

async function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = await scrypt(password, salt, 64);
  return { salt, hash: derived.toString('hex') };
}

async function saveUsers() {
  const serialized = JSON.stringify(users, null, 2);
  userWriteQueue = userWriteQueue.then(async () => {
    await fs.promises.mkdir(EVENT_DATA_DIR, { recursive: true, mode: 0o700 });
    await fs.promises.chmod(EVENT_DATA_DIR, 0o700);
    const temporaryPath = `${USER_STORE_PATH}.tmp`;
    await fs.promises.writeFile(temporaryPath, serialized, { mode: 0o600 });
    await fs.promises.rename(temporaryPath, USER_STORE_PATH);
    await fs.promises.chmod(USER_STORE_PATH, 0o600);
  });
  return userWriteQueue;
}

function isIncidentPayload(payload) {
  const state = String(payload.accident_state || '').toUpperCase();
  const type = String(payload.message_type || '').toLowerCase();
  return Boolean(payload.event_id) && (
    !['', 'NONE', 'NORMAL'].includes(state) ||
    /accident|sos|overspeed|alert|sms|acknowledg/.test(type)
  );
}

function persistIncident(payload) {
  if (payload?.demo_mode === true || payload?._vtaas_comparison) return Promise.resolve(false);
  if (!isIncidentPayload(payload)) return Promise.resolve(false);
  const id = String(payload.event_id);
  const merged = { ...(bufferedEvents.get(id) || {}), ...payload, event_id: id };
  bufferedEvents.delete(id);
  bufferedEvents.set(id, merged);
  while (bufferedEvents.size > MAX_STORED_EVENTS) bufferedEvents.delete(bufferedEvents.keys().next().value);
  const serialized = JSON.stringify([...bufferedEvents.entries()].map(([event_id, savedPayload]) => ({ event_id, payload: savedPayload })));
  eventWriteQueue = eventWriteQueue.then(async () => {
    await fs.promises.mkdir(EVENT_DATA_DIR, { recursive: true });
    const temporaryPath = `${EVENT_STORE_PATH}.tmp`;
    await fs.promises.writeFile(temporaryPath, serialized, { mode: 0o600 });
    await fs.promises.rename(temporaryPath, EVENT_STORE_PATH);
  });
  return eventWriteQueue.then(() => true);
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function serveFile(res, pathname, method = 'GET') {
  const relative = pathname === '/' || pathname === '/index.html' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(ROOT, relative);
  if (!file.startsWith(`${ROOT}${path.sep}`) && file !== ROOT) return send(res, 403, { error: 'Forbidden.' });
  if (relative === 'data' || relative.startsWith('data/') || file === EVENT_DATA_DIR || file.startsWith(`${EVENT_DATA_DIR}${path.sep}`)) return send(res, 404, { error: 'Not found.' });
  fs.readFile(file, (error, data) => {
    if (error) return send(res, error.code === 'ENOENT' ? 404 : 500, { error: error.code === 'ENOENT' ? 'Not found.' : 'Could not read file.' });
    const extension = path.extname(file);
    res.writeHead(200, { 'content-type': contentTypes[extension] || 'application/octet-stream', 'cache-control': ['.html', '.js', '.css'].includes(extension) ? 'no-cache' : 'public, max-age=300', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin' });
    res.end(method === 'HEAD' ? undefined : data);
  });
}

function parseJsonObject(buffer) {
  const value = JSON.parse(buffer.toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected one JSON object.');
  return value;
}

function broadcast(message, except) {
  const text = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client !== except && client.dashboardUser && client.readyState === WebSocket.OPEN) client.send(text);
  }
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let bytes = 0;
    req.on('data', part => {
      bytes += part.length;
      if (bytes > MAX_BODY_BYTES) { reject(new Error('Payload exceeds 64 KB.')); req.destroy(); return; }
      parts.push(part);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  const user = sessionFromRequest(req);
  if (req.method === 'GET' && pathname === '/api/auth/session') return user ? send(res, 200, { authenticated: true, user: publicUser(user) }) : send(res, 401, { authenticated: false, registration_open: true });
  if (req.method === 'POST' && ['/api/auth/register', '/api/auth/login', '/api/auth/logout'].includes(pathname)) {
    if (!sameOrigin(req)) return send(res, 403, { error: 'Request origin was rejected.' });
    if (!consumeAuthAttempt(req)) return send(res, 429, { error: 'Too many attempts. Wait a few minutes and try again.' });
    if (pathname === '/api/auth/logout') {
      const sessionKey = sessionKeyFromRequest(req);
      if (sessionKey) {
        sessions.delete(sessionKey);
        for (const client of wss.clients) if (client.sessionKey === sessionKey) client.close(1000, 'Signed out.');
      }
      clearSessionCookie(res, req);
      return send(res, 200, { ok: true });
    }
    try {
      const body = parseJsonObject(await collectBody(req));
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || password.length < 8 || password.length > 128) {
        return send(res, 400, { error: 'Enter a valid email and a password between 8 and 128 characters.' });
      }
      if (pathname === '/api/auth/login') {
        const match = users.find(item => item.email === email);
        if (!match) return send(res, 401, { error: 'Email or password is incorrect.' });
        const candidate = await scrypt(password, match.password_salt, 64);
        const expected = Buffer.from(match.password_hash, 'hex');
        if (expected.length !== candidate.length || !crypto.timingSafeEqual(expected, candidate)) return send(res, 401, { error: 'Email or password is incorrect.' });
        setSession(res, req, match);
        return send(res, 200, { ok: true, user: publicUser(match) });
      }
      const name = String(body.name || '').trim();
      if (name.length < 2 || name.length > 60) return send(res, 400, { error: 'Name must be between 2 and 60 characters.' });
      if (users.some(item => item.email === email) || pendingRegistrationEmails.has(email)) return send(res, 409, { error: 'An account with that email already exists.' });
      pendingRegistrationEmails.add(email);
      try {
        const passwordData = await hashPassword(password);
        const account = { id: crypto.randomUUID(), name, email, password_salt: passwordData.salt, password_hash: passwordData.hash, created_at: new Date().toISOString() };
        users.push(account);
        try { await saveUsers(); } catch (error) { users.pop(); throw error; }
        setSession(res, req, account);
        return send(res, 201, { ok: true, user: publicUser(account) });
      } finally { pendingRegistrationEmails.delete(email); }
    } catch (error) {
      if (!res.headersSent && !res.destroyed) return send(res, error instanceof SyntaxError ? 400 : 500, { error: error instanceof SyntaxError ? 'Request must be valid JSON.' : 'Could not complete that account request.' });
      return;
    }
  }
  if (req.method === 'OPTIONS') return send(res, 204, '');
  if (req.method === 'GET' && pathname === '/health') return send(res, 200, { ok: true, service: 'vt-aas-dashboard', websocket: '/ws', telemetry: '/api/telemetry', buffered_events: bufferedEvents.size });
  if (req.method === 'GET' && pathname === '/api/events') return user ? send(res, 200, { events: [...bufferedEvents.values()], count: bufferedEvents.size }) : send(res, 401, { error: 'Sign in to view incident history.' });
  if (req.method === 'POST' && pathname === '/api/telemetry') {
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return send(res, 415, { accepted: false, error: 'Content-Type must be application/json.' });
    try {
      const payload = parseJsonObject(await collectBody(req));
      let incidentSaved = false;
      try { incidentSaved = await persistIncident(payload); }
      catch (error) {
        if (isIncidentPayload(payload)) return send(res, 503, { accepted: false, relay_saved: false, error: `Could not save incident to the local relay buffer: ${error.message}` });
      }
      broadcast(payload);
      return send(res, 202, { accepted: true, incident_saved: incidentSaved, timestamp: new Date().toISOString() });
    } catch (error) {
      if (!res.headersSent && !res.destroyed) return send(res, error instanceof SyntaxError ? 400 : 413, { accepted: false, error: error.message });
      return;
    }
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed.' });
  if (FIREBASE_AUTH_CONFIGURED) {
    if (pathname === '/auth' || pathname === '/login' || pathname === '/register' || pathname === '/auth.html') return serveFile(res, '/auth.html', req.method);
    return serveFile(res, pathname, req.method);
  }
  if (pathname === '/auth' || pathname === '/login' || pathname === '/register' || pathname === '/auth.html') return serveFile(res, user ? '/' : '/auth.html', req.method);
  if (!user && ['/auth.js', '/auth.css'].includes(pathname)) return serveFile(res, pathname, req.method);
  if (!user) return serveFile(res, '/auth.html', req.method);
  return serveFile(res, pathname, req.method);
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY_BYTES });
server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  if (pathname !== '/ws') { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }
  const origin = req.headers.origin;
  const user = origin && sameOrigin(req) ? sessionFromRequest(req) : null;
  if (origin && !user) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
  req.dashboardUser = user;
  req.dashboardSessionKey = user ? sessionKeyFromRequest(req) : null;
  wss.handleUpgrade(req, socket, head, client => wss.emit('connection', client, req));
});

wss.on('connection', (client, req) => {
  client.dashboardUser = req.dashboardUser || null;
  client.sessionKey = req.dashboardSessionKey || null;
  const session = client.sessionKey ? sessions.get(client.sessionKey) : null;
  if (session) client.sessionTimer = setTimeout(() => client.close(1008, 'Session expired.'), Math.max(0, session.expiresAt - Date.now()));
  client.on('close', () => clearTimeout(client.sessionTimer));
  client.on('message', async (data, isBinary) => {
    if (isBinary) { client.close(1003, 'Send UTF-8 JSON text.'); return; }
    try {
      const payload = parseJsonObject(data);
      try { await persistIncident(payload); }
      catch (error) { if (isIncidentPayload(payload)) { client.close(1011, 'Incident could not be saved on relay.'); return; } }
      broadcast(payload, client);
    } catch (error) { client.send(JSON.stringify({ message_type: 'error', error: error.message })); }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`VT&AAS dashboard listening on http://localhost:${PORT}`);
  console.log(`Local accounts: ${users.length} · first-time visitors can register at /register`);
  console.log(`ESP32 HTTP telemetry endpoint: http://<computer-ip>:${PORT}/api/telemetry`);
  console.log(`Dashboard WebSocket endpoint: ws://<computer-ip>:${PORT}/ws`);
});

function close() { wss.close(() => server.close(() => process.exit(0))); }
process.on('SIGINT', close);
process.on('SIGTERM', close);
