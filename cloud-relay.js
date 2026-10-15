'use strict';

// Authenticated WebSocket relay used only for the browser protocol comparison.
// Firebase ID tokens are verified before a socket may publish or receive data.
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT || 8081);
const HOST = process.env.HOST || '0.0.0.0';
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'vt-aas';
const MAX_MESSAGE_BYTES = 32 * 1024;
const AUTH_TIMEOUT_MS = 8000;
const DEFAULT_ORIGINS = [
  'https://vt-aas.web.app',
  'https://vt-aas.firebaseapp.com',
  'http://localhost:8080',
  'http://127.0.0.1:8080'
];
const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS || DEFAULT_ORIGINS.join(','))
  .split(',').map(value => value.trim()).filter(Boolean));
const certificateUrl = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
let signingCertificates = null;
let certificatesExpireAt = 0;

function decodePart(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

async function loadCertificates(force = false) {
  if (!force && signingCertificates && Date.now() < certificatesExpireAt) return signingCertificates;
  const response = await fetch(certificateUrl, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error('Could not retrieve Firebase signing certificates.');
  const certificates = await response.json();
  const cacheControl = response.headers.get('cache-control') || '';
  const maxAge = Number(cacheControl.match(/max-age=(\d+)/i)?.[1] || 300);
  signingCertificates = certificates;
  certificatesExpireAt = Date.now() + Math.max(60, maxAge) * 1000;
  return signingCertificates;
}

async function verifyFirebaseToken(token) {
  if (typeof token !== 'string' || token.length > 10000) throw new Error('A valid Firebase sign-in is required.');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid sign-in token.');
  const header = decodePart(parts[0]);
  const payload = decodePart(parts[1]);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('Unsupported sign-in token.');
  let certificates = await loadCertificates();
  if (!certificates[header.kid]) certificates = await loadCertificates(true);
  const certificate = certificates[header.kid];
  if (!certificate) throw new Error('Unknown sign-in key.');
  const signedContent = Buffer.from(`${parts[0]}.${parts[1]}`);
  const signature = Buffer.from(parts[2], 'base64url');
  if (!crypto.verify('RSA-SHA256', signedContent, certificate, signature)) throw new Error('Invalid sign-in signature.');

  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== `https://securetoken.google.com/${PROJECT_ID}` || payload.aud !== PROJECT_ID ||
      typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 128 ||
      !Number.isFinite(payload.exp) || payload.exp <= now || !Number.isFinite(payload.iat) || payload.iat > now + 60) {
    throw new Error('Sign-in token is expired or belongs to another project.');
  }
  return payload.sub;
}

function safeSend(client, value) {
  if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(value));
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ status: 'ok', service: 'vtaas-comparison-relay' }));
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
  res.end('Not found');
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });
server.on('upgrade', (req, socket, head) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); socket.destroy(); return; }
  const origin = req.headers.origin;
  if (url.pathname !== '/ws' || !origin || !allowedOrigins.has(origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
  }
  wss.handleUpgrade(req, socket, head, client => wss.emit('connection', client, req));
});

wss.on('connection', client => {
  client.authenticatedUid = null;
  client.comparisonRunId = null;
  client.authTimer = setTimeout(() => client.close(1008, 'Sign in required.'), AUTH_TIMEOUT_MS);
  client.on('close', () => clearTimeout(client.authTimer));
  client.on('message', async (bytes, isBinary) => {
    if (isBinary) { client.close(1003, 'Send JSON text frames only.'); return; }
    let message;
    try { message = JSON.parse(bytes.toString('utf8')); }
    catch { client.close(1007, 'Invalid JSON.'); return; }
    if (!message || typeof message !== 'object' || Array.isArray(message)) { client.close(1007, 'Expected a JSON object.'); return; }

    if (!client.authenticatedUid) {
      if (message.type !== 'auth' || typeof message.run_id !== 'string' || message.run_id.length > 100) {
        client.close(1008, 'Sign in and a comparison run are required.'); return;
      }
      try {
        client.authenticatedUid = await verifyFirebaseToken(message.token);
        client.comparisonRunId = message.run_id;
        clearTimeout(client.authTimer);
        safeSend(client, { type: 'auth_ok' });
      } catch {
        safeSend(client, { type: 'error', error: 'Sign-in could not be verified.' });
        client.close(1008, 'Sign-in could not be verified.');
      }
      return;
    }

    const marker = message._vtaas_comparison;
    const runId = marker?.run_id;
    if (message.demo_mode !== true || typeof runId !== 'string' || runId.length > 100 ||
        !Number.isSafeInteger(Number(marker.sequence)) || !Number.isFinite(Number(marker.sent_at_ms))) {
      client.close(1008, 'Only marked comparison demo packets are accepted.'); return;
    }
    if (client.comparisonRunId !== runId) { client.close(1008, 'Comparison run does not match.'); return; }
    const text = JSON.stringify(message);
    for (const peer of wss.clients) {
      if (peer !== client && peer.authenticatedUid === client.authenticatedUid &&
          peer.comparisonRunId === runId && peer.readyState === WebSocket.OPEN) peer.send(text);
    }
  });
});

server.listen(PORT, HOST, () => console.log(`VT&AAS comparison relay listening on ${HOST}:${PORT}`));
function close() { wss.close(() => server.close(() => process.exit(0))); }
process.on('SIGINT', close);
process.on('SIGTERM', close);
