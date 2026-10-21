const FIREBASE_CERT_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
const MAX_MESSAGE_CHARS = 32 * 1024;

let firebaseCertificates;
let firebaseCertificatesExpireAt = 0;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/healthz') {
      return Response.json({ status: 'ok', service: 'vtaas-ws-relay' }, { headers: { 'cache-control': 'no-store' } });
    }
    if (url.pathname !== '/ws' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
    }

    const origin = request.headers.get('Origin');
    const allowedOrigins = new Set((env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean));
    if (origin && !allowedOrigins.has(origin)) return new Response('Origin not allowed', { status: 403 });

    const id = env.RELAY.idFromName(env.VEHICLE_ID || 'vehicle_01');
    return env.RELAY.get(id).fetch(request);
  }
};

export class VtaasRelay {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected WebSocket upgrade', { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ role: null, uid: null, runId: null, vehicleId: this.env.VEHICLE_ID || 'vehicle_01' });
    server.send(JSON.stringify({ type: 'ready' }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket, raw) {
    if (typeof raw !== 'string' || raw.length > MAX_MESSAGE_CHARS) {
      socket.close(1009, 'Message too large or not text.');
      return;
    }

    let message;
    try { message = JSON.parse(raw); }
    catch { socket.close(1007, 'Invalid JSON.'); return; }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      socket.close(1007, 'Expected a JSON object.');
      return;
    }

    const attachment = socket.deserializeAttachment() || {};
    if (!attachment.role) {
      await this.authenticate(socket, message, attachment);
      return;
    }

    if (attachment.role === 'compare') {
      this.relayComparisonPacket(socket, message, attachment);
      return;
    }
    if (attachment.role === 'device') {
      this.relayDeviceTelemetry(socket, message, attachment);
      return;
    }

    if (attachment.role === 'dashboard' && message.message_type === 'benchmark_ping') {
      this.relayDeviceProbe(socket, message, attachment); return;
    }
    // Sensor commands and arbitrary dashboard messages remain forbidden.
    socket.close(1008, 'Dashboard accepts only diagnostic pings.');
  }

  async authenticate(socket, message, previous) {
    if (message.type !== 'auth') { socket.close(1008, 'Authenticate before sending data.'); return; }

    // The existing comparison demo uses authenticated browser sockets and run IDs.
    if (typeof message.run_id === 'string' && message.run_id.length > 0 && message.run_id.length <= 100) {
      try {
        const uid = await verifyFirebaseToken(message.token, this.env.FIREBASE_PROJECT_ID || 'vt-aas');
        socket.serializeAttachment({ ...previous, role: 'compare', uid, runId: message.run_id });
        socket.send(JSON.stringify({ type: 'auth_ok' }));
      } catch {
        socket.send(JSON.stringify({ type: 'error', error: 'Sign-in could not be verified.' }));
        socket.close(1008, 'Sign-in could not be verified.');
      }
      return;
    }

    if (message.role === 'dashboard') {
      try {
        const uid = await verifyFirebaseToken(message.token, this.env.FIREBASE_PROJECT_ID || 'vt-aas');
        const vehicleId = this.env.VEHICLE_ID || 'vehicle_01';
        if (message.vehicle_id && message.vehicle_id !== vehicleId) throw new Error('Unknown vehicle.');
        socket.serializeAttachment({ ...previous, role: 'dashboard', uid, vehicleId, connectionId: crypto.randomUUID() });
        socket.send(JSON.stringify({ type: 'auth_ok', vehicle_id: vehicleId, benchmark: 'device_ping_v1' }));
      } catch {
        socket.send(JSON.stringify({ type: 'error', error: 'Dashboard sign-in could not be verified.' }));
        socket.close(1008, 'Sign-in could not be verified.');
      }
      return;
    }

    if (message.role === 'device') {
      const expected = this.env.DEVICE_WS_TOKEN || '';
      if (!expected || !constantTimeEqual(message.token, expected)) {
        socket.send(JSON.stringify({ type: 'error', error: 'Device authentication failed.' }));
        socket.close(1008, 'Device authentication failed.');
        return;
      }
      socket.serializeAttachment({ ...previous, role: 'device', vehicleId: this.env.VEHICLE_ID || 'vehicle_01' });
      socket.send(JSON.stringify({ type: 'auth_ok', vehicle_id: this.env.VEHICLE_ID || 'vehicle_01' }));
      return;
    }

    socket.close(1008, 'Unknown WebSocket client role.');
  }

  relayComparisonPacket(socket, message, attachment) {
    const marker = message._vtaas_comparison;
    const runId = marker?.run_id;
    if (message.demo_mode !== true || typeof runId !== 'string' || runId.length > 100 ||
        !Number.isSafeInteger(Number(marker.sequence)) || !Number.isFinite(Number(marker.sent_at_ms)) ||
        runId !== attachment.runId) {
      socket.close(1008, 'Only marked packets for this demo run are accepted.');
      return;
    }
    const text = JSON.stringify(message);
    for (const peer of this.ctx.getWebSockets()) {
      if (peer === socket) continue;
      const peerInfo = peer.deserializeAttachment() || {};
      if (peerInfo.role === 'compare' && peerInfo.uid === attachment.uid && peerInfo.runId === runId) safeSend(peer, text);
    }
  }

  relayDeviceProbe(socket, message, attachment) {
    if (typeof message.probe_id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(message.probe_id)) return;
    const now = Date.now();
    if (attachment.lastProbeAt && now - attachment.lastProbeAt < 4000) return;
    const connectionId = attachment.connectionId || crypto.randomUUID();
    socket.serializeAttachment({ ...attachment, connectionId, lastProbeAt: now });
    const ping = JSON.stringify({ message_type: 'benchmark_ping', probe_id: message.probe_id, probe_client: connectionId });
    for (const peer of this.ctx.getWebSockets()) {
      const info = peer.deserializeAttachment() || {};
      if (info.role === 'device' && info.vehicleId === attachment.vehicleId) safeSend(peer, ping);
    }
  }

  relayDeviceTelemetry(socket, message, attachment) {
    if (message.message_type === 'benchmark_pong') {
      if (typeof message.probe_id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(message.probe_id) ||
          typeof message.probe_client !== 'string' || message.probe_client.length > 100) return;
      const pong = JSON.stringify({ message_type: 'benchmark_pong', probe_id: message.probe_id, device_id: attachment.vehicleId });
      for (const peer of this.ctx.getWebSockets()) {
        const info = peer.deserializeAttachment() || {};
        if (info.role === 'dashboard' && info.vehicleId === attachment.vehicleId && info.connectionId === message.probe_client) safeSend(peer, pong);
      }
      return;
    }
    if (message.type === 'auth' || message.demo_mode === true || message._vtaas_comparison) {
      socket.close(1008, 'Device connection accepts live telemetry only.');
      return;
    }
    if (typeof message !== 'object' || Array.isArray(message)) { socket.close(1007, 'Expected a telemetry object.'); return; }
    const text = JSON.stringify({ ...message, device_id: message.device_id || attachment.vehicleId });
    for (const peer of this.ctx.getWebSockets()) {
      const peerInfo = peer.deserializeAttachment() || {};
      if (peerInfo.role === 'dashboard' && peerInfo.vehicleId === attachment.vehicleId) safeSend(peer, text);
    }
  }

  webSocketClose(socket) { try { socket.close(); } catch {} }
  webSocketError(socket) { try { socket.close(1011, 'WebSocket error.'); } catch {} }
}

function safeSend(socket, value) {
  try { socket.send(typeof value === 'string' ? value : JSON.stringify(value)); }
  catch { try { socket.close(1011, 'Could not forward telemetry.'); } catch {} }
}

function constantTimeEqual(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || actual.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < actual.length; i += 1) difference |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return difference === 0;
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function decodeJsonPart(value) {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
}

function readDer(bytes, offset) {
  const tag = bytes[offset];
  let cursor = offset + 1;
  let length = bytes[cursor++];
  if (length & 0x80) {
    const count = length & 0x7f;
    length = 0;
    for (let i = 0; i < count; i += 1) length = (length * 256) + bytes[cursor++];
  }
  return { tag, start: offset, contentStart: cursor, end: cursor + length, next: cursor + length };
}

function certificateSpki(certificatePem) {
  const base64 = certificatePem.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s/g, '');
  const der = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
  const outer = readDer(der, 0);
  const tbs = readDer(der, outer.contentStart);
  let cursor = tbs.contentStart;
  let item = readDer(der, cursor);
  if (item.tag === 0xa0) cursor = item.next;
  for (let i = 0; i < 5; i += 1) cursor = readDer(der, cursor).next;
  const spki = readDer(der, cursor);
  return der.slice(spki.start, spki.next);
}

async function loadFirebaseCertificates() {
  if (firebaseCertificates && Date.now() < firebaseCertificatesExpireAt) return firebaseCertificates;
  const response = await fetch(FIREBASE_CERT_URL, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error('Could not load Firebase signing certificates.');
  firebaseCertificates = await response.json();
  const maxAge = Number((response.headers.get('cache-control') || '').match(/max-age=(\d+)/i)?.[1] || 300);
  firebaseCertificatesExpireAt = Date.now() + Math.max(60, maxAge) * 1000;
  return firebaseCertificates;
}

async function verifyFirebaseToken(token, projectId) {
  if (typeof token !== 'string' || token.length > 10000) throw new Error('Invalid token.');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid token.');
  const header = decodeJsonPart(parts[0]);
  const payload = decodeJsonPart(parts[1]);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('Unsupported token.');
  let certificates = await loadFirebaseCertificates();
  if (!certificates[header.kid]) {
    firebaseCertificatesExpireAt = 0;
    certificates = await loadFirebaseCertificates();
  }
  if (!certificates[header.kid]) throw new Error('Unknown signing key.');
  const key = await crypto.subtle.importKey('spki', certificateSpki(certificates[header.kid]), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const signature = decodeBase64Url(parts[2]);
  const signedBytes = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signedBytes)) throw new Error('Invalid signature.');
  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== `https://securetoken.google.com/${projectId}` || payload.aud !== projectId ||
      typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 128 ||
      !Number.isFinite(payload.exp) || payload.exp <= now || !Number.isFinite(payload.iat) || payload.iat > now + 60) {
    throw new Error('Expired or wrong-project token.');
  }
  return payload.sub;
}
