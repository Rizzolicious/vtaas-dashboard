(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const STORAGE_KEY = 'roadwatch.events.v1';
  const HISTORY_CLEAR_KEY = 'vtaas.events.cleared-at';
  const CALIBRATION_KEY = 'vtaas.sensor-baseline.v1';
  const MAX_POINTS = 60;
  const SPEED_LIMIT_DEFAULT = 80;
  const BLE_BUFFER_LIMIT = 65536;
  // Precomputed from the mapped streets around the demo's Bharuch starting point.
  const DEMO_ROAD_ROUTE = [
    [72.995964, 21.708422], [72.996285, 21.709072], [72.996817, 21.708864], [72.996607, 21.709824],
    [72.996832, 21.711815], [72.995058, 21.711795], [72.993864, 21.711234], [72.992294, 21.710865],
    [72.992276, 21.710945], [72.994015, 21.711359], [72.994741, 21.71178], [72.995055, 21.711875],
    [72.996818, 21.711905], [72.998937, 21.712053], [72.999951, 21.712418], [73.000365, 21.712326],
    [73.000684, 21.71205], [73.000985, 21.711964], [73.001148, 21.711693], [73.000277, 21.705266],
    [73.000044, 21.70532], [73.000062, 21.705461], [72.999337, 21.705343], [72.999038, 21.70639],
    [72.998596, 21.708499], [72.998714, 21.709136], [72.999052, 21.709617], [72.998995, 21.710031]
  ];
  const DEMO_ROUTE_LOOP = [...DEMO_ROAD_ROUTE, ...DEMO_ROAD_ROUTE.slice(0, -1).reverse()];
  const DEMO_ROUTE_SEGMENTS = DEMO_ROUTE_LOOP.slice(1).map((point, index) => {
    const from = DEMO_ROUTE_LOOP[index];
    const lat1 = from[1] * Math.PI / 180, lat2 = point[1] * Math.PI / 180;
    const dLat = lat2 - lat1, dLon = (point[0] - from[0]) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return { from, to: point, length: 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) };
  });
  const DEMO_ROUTE_LENGTH = DEMO_ROUTE_SEGMENTS.reduce((sum, segment) => sum + segment.length, 0);

  const model = {
    protocol: 'demo', protocolLock: null, connected: false, connectionState: 'disconnected', transportGeneration: 0, connectionTimer: null, messageCount: 0, errorCount: 0, reconnectCount: 0,
    lastMessageAt: null, lastGpsAt: null, telemetry: null, acceleration: [], gyroscope: [], preEventBuffer: [],
    events: loadEvents(), eventIds: new Set(), currentEventId: null, alertDismissed: false, deviceId: null,
    cloudMode: false, cloudUnsubscribers: [], firebaseClient: null,
    calibration: loadCalibration(), calibrationCapture: null, calibrationTimer: null, calibrationMessage: '',
    demoTime: 0, demoDistance: 0, demoPreviousSpeed: null, demoPreviousHeading: null, demoPreviousRoll: null, demoPreviousPitch: null, demoLastMotionAt: null,
    gpsUnavailableUntil: 0, demoCancelledUntil: 0, demoCountdown: 0,
    demoAccidentActive: false, demoCrashGps: null, demoImpactUntil: 0, demoCountdownEndsAt: 0, demoCountdownInterval: null, demoAccidentSeverity: 'NONE',
    chartMode: 'accel', ws: null, mqtt: null, bleDevice: null, bleServer: null,
    bleCharacteristic: null, bleBuffer: '', bleProbe: null, bleProbeTimer: null, bleProbePending: null, bleProbeId: 0,
    bleRtts: [], bleLastRttAt: null, bleDelivery: null, networkProbeTimer: null, networkProbeSend: null, networkProbePending: null, networkProbeSession: '', networkProbeId: 0, networkRtts: [], networkLastRttAt: null, reconnectTimer: null, reconnectAttempt: 0,
    intentionalDisconnect: false, map: null, mapMarker: null, mapTiles: null, mapResizeFrame: null, mapResizeObserver: null, evidenceMap: null, toastTimer: null, historyQuery: '', historyFilter: 'all'
  };

  model.events.forEach(event => model.eventIds.add(event.event_id));

  function loadEvents() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      return Array.isArray(parsed) ? parsed.filter(item => item && item.event_id) : [];
    } catch { return []; }
  }

  function loadCalibration() {
    try { return JSON.parse(localStorage.getItem(CALIBRATION_KEY) || 'null'); }
    catch { return null; }
  }

  function saveCalibration(value) {
    model.calibration = value;
    try { value ? localStorage.setItem(CALIBRATION_KEY, JSON.stringify(value)) : localStorage.removeItem(CALIBRATION_KEY); }
    catch { showToast('Could not save the sensor reference in this browser.'); }
    renderCalibrationPanel();
  }

  function saveEvents() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(model.events.slice(0, 300))); }
    catch { showToast('Could not save history in this browser. Export events to keep a copy.'); }
  }

  function showToast(message) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(model.toastTimer);
    model.toastTimer = setTimeout(() => toast.classList.remove('show'), 3000);
  }

  function localTime(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return '—';
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function shortTime(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '—';
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function safeText(value, fallback = '—') {
    return value === null || value === undefined || value === '' ? fallback : String(value);
  }

  function finite(value) { if (value === null || value === undefined || value === '') return null; const number = Number(value); return Number.isFinite(number) ? number : null; }
  function round(value, digits = 2) { return Number.isFinite(value) ? value.toFixed(digits) : '—'; }

  function displayPage(page) {
    $$('.page').forEach(node => node.classList.toggle('active', node.id === `page-${page}`));
    $$('.nav-item').forEach(node => node.classList.toggle('active', node.dataset.page === page));
    const titles = { overview: 'Overview', sensors: 'Live sensors', protocols: 'Protocols', history: 'Event history' };
    $('#crumb-title').textContent = titles[page] || 'Overview';
    if (page === 'history') renderHistory();
    if (page === 'overview') invalidateMapSize();
  }

  function mapIsVisible() {
    const canvas = $('#map-canvas');
    return $('#page-overview').classList.contains('active') && canvas.clientWidth > 0 && canvas.clientHeight > 0;
  }

  function invalidateMapSize() {
    if (model.mapResizeFrame !== null) return;
    model.mapResizeFrame = requestAnimationFrame(() => {
      model.mapResizeFrame = null;
      if (!mapIsVisible()) return;
      if (model.map) model.map.invalidateSize({ pan: false, debounceMoveend: true });
      if (model.telemetry?.gps) updateMap(model.telemetry.gps);
    });
  }

  function updateProtocolLock() {
    const locked = model.protocolLock !== null;
    $$('.protocol-tab').forEach(tab => {
      tab.disabled = locked && tab.dataset.protocol !== model.protocolLock;
      tab.title = tab.disabled ? 'Disconnect the current protocol to switch.' : '';
    });
    $$('.connect-button, .protocol-form input').forEach(control => { control.disabled = locked; });
    $('#simulate-event').disabled = locked && model.protocolLock !== 'demo';
    $$('[data-scenario]').forEach(button => { button.disabled = locked && model.protocolLock !== 'demo'; });
    const note = $('#protocol-lock-note');
    note.hidden = !locked;
    note.textContent = locked ? 'Disconnect the current protocol before switching. You can still view your dashboard.' : '';
  }

  function canStartProtocol() {
    if (model.protocolLock === null) return true;
    showToast('Disconnect the current protocol before starting another connection or demo.');
    return false;
  }

  function lockProtocol(protocol) {
    model.protocolLock = protocol;
    updateProtocolLock();
  }

  function setProtocolTab(protocol) {
    if (model.protocolLock !== null && protocol !== model.protocolLock) {
      showToast('Disconnect the current protocol before switching.');
      return;
    }
    $$('.protocol-tab').forEach(tab => tab.classList.toggle('selected', tab.dataset.protocol === protocol));
    ['demo', 'websocket', 'mqtt', 'bluetooth', 'firebase'].forEach(name => $(`#form-${name}`).classList.toggle('hidden', name !== protocol));
    model.protocolSelection = protocol;
    if (model.protocolLock === null && model.connectionState === 'disconnected' && model.protocol !== protocol) {
      model.protocol = protocol; model.deviceId = null;
      clearTelemetryForLiveWait();
      toggleProtocolConnectionState('disconnected', `${protocolName(protocol)} selected. Connect to start receiving data.`);
    }
    const titles = { firebase: ['Firebase cloud', 'Choose a protocol above to connect your ESP32, or start the demo.', 'CLOUD'], demo: ['Demo stream', 'Explore the dashboard using simulated vehicle messages.', 'DEMO'], websocket: ['WebSocket', 'Connect directly to a WebSocket server on your ESP32 or gateway.', 'WS'], mqtt: ['MQTT', 'Subscribe to an MQTT broker through its WebSocket listener.', 'MQTT'], bluetooth: ['Bluetooth LE', 'Receive telemetry from an ESP32 BLE GATT characteristic.', 'BLE'] };
    const [title, description, badge] = titles[protocol];
    $('#protocol-title').textContent = title;
    $('#protocol-description').textContent = description;
    $('#protocol-badge').textContent = badge;
    if (protocol !== model.protocol) {
      $('#selected-protocol-value').textContent = title.replace(' stream', '');
    }
  }

  function failConnection(message) {
    model.intentionalDisconnect = true;
    cleanupTransport({ preserveMeasurements: true });
    toggleProtocolConnectionState('disconnected', message);
    showToast(message);
  }

  function startConnectionDeadline(message) {
    clearTimeout(model.connectionTimer);
    const generation = model.transportGeneration;
    model.connectionTimer = setTimeout(() => {
      if (generation !== model.transportGeneration || model.connectionState !== 'connecting') return;
      model.errorCount += 1; updateConnectionCounters();
      failConnection(message);
    }, 20000);
  }

  function protocolName(protocol = model.protocol) {
    return ({ demo: 'Demo', websocket: 'WebSocket', mqtt: 'MQTT', bluetooth: 'Bluetooth LE', firebase: 'Firebase cloud' })[protocol] || 'Device';
  }

  function toggleProtocolConnectionState(state, copy) {
    state = typeof state === 'boolean' ? (state ? 'connected' : 'disconnected') : state;
    model.connectionState = state;
    const connected = state === 'connected';
    if (state !== 'connecting') { clearTimeout(model.connectionTimer); model.connectionTimer = null; }
    const busy = state === 'connecting' || state === 'disconnecting';
    model.connected = connected;
    const label = state.toUpperCase(), color = connected ? 'var(--green)' : busy ? 'var(--amber)' : 'var(--red)';
    for (const id of ['connection-dot', 'protocol-connection-dot', 'unit-dot']) {
      $(`#${id}`).classList.toggle('offline', !connected && !busy);
      $(`#${id}`).classList.toggle('warning', busy);
    }
    $('#connection-state').textContent = label;
    $('#connection-state').className = `connection-state ${busy ? 'status-amber' : connected ? '' : 'status-red'}`;
    $('#big-connection-state').textContent = label;
    $('#big-connection-state').style.color = color;
    $('#protocol-status-copy').textContent = copy;
    $('#connection-status').textContent = copy;
    $('#selected-protocol-value').textContent = protocolName();
    $('#disconnect-button').disabled = state === 'disconnecting' || (state === 'disconnected' && model.protocolLock === null && model.protocol !== 'demo');
    $('#disconnect-button').textContent = state === 'disconnecting' ? 'Disconnecting…' : model.protocol === 'demo' ? (connected ? 'Stop demo' : 'Start demo') : 'Disconnect';
    $('#sensor-page-live').textContent = `${protocolName()} · ${state}`;
    $('#sensor-description').textContent = model.protocol === 'demo' ? 'Demo mode uses simulated sensor and GPS values.' : 'Motion and GPS readings received from the ESP32.';
    $('#health-description').textContent = model.protocol === 'demo' ? 'Simulated values are shown for the dashboard demo.' : 'Hardware values appear only when reported by the ESP32.';
    $('#live-mode').textContent = `${protocolName().toUpperCase()} · ${label}`;
    $('#live-dot').style.background = color;
    $('#live-dot').style.boxShadow = `0 0 0 3px ${connected ? '#16392e' : busy ? '#41351f' : '#402424'}`;
    $('#connection-name').textContent = protocolName();
    $('#protocol-mark').textContent = ({ demo: 'D', websocket: 'W', mqtt: 'M', bluetooth: 'B', firebase: 'F' })[model.protocol];
    $('#protocol-mark').style.color = color;
    $('.unit-link i').style.background = color;
    if (!connected && model.telemetry) $('#sensor-freshness').textContent = `Last reading · ${state}`;
    if (model.telemetry?.gps?.valid) $('#map-location-label').textContent = model.protocol === 'demo' ? 'DEMO LOCATION' : model.telemetry?.simulation === true ? (connected ? 'SIMULATED LOCATION' : 'LAST SIMULATED LOCATION') : connected ? 'LIVE LOCATION' : 'LAST LOCATION';
    syncCloudAction(); updateUnitCard(); renderCalibrationPanel();
  }

  function beginProtocolSession() {
    model.deviceId = null;
    model.messageCount = 0; model.errorCount = 0; model.reconnectCount = 0; model.reconnectAttempt = 0;
    clearTelemetryForLiveWait();
    $('#protocol-last-message').textContent = '—';
    updateConnectionCounters();
  }

  function syncCloudAction() {
    const button = $('#protocol-shortcut');
    if (!button) return;
    if (model.protocolLock !== null) {
      button.innerHTML = '<span class="button-pulse"></span>Manage connection';
      button.setAttribute('aria-label', 'Manage the current connection');
    } else if (model.protocol === 'demo' && model.firebaseClient) {
      button.innerHTML = '<span class="button-pulse"></span>Return to live cloud';
      button.setAttribute('aria-label', 'Return to live Firebase data');
    } else {
      button.innerHTML = '<span class="button-pulse"></span>Connect device';
      button.setAttribute('aria-label', 'Connect a device');
    }
  }

  function updateUnitCard() {
    const demo = model.protocol === 'demo', state = model.connectionState;
    const id = demo ? 'DEMO-01' : model.telemetry?.device_id || model.deviceId;
    const named = demo ? 'Demo vehicle' : model.telemetry?.vehicle_name || model.telemetry?.device_name;
    const defaultName = id ? (id === 'vehicle_01' ? 'Vehicle 01' : `Vehicle ${id}`) : 'Waiting for device';
    $('#unit-mode').textContent = demo ? 'DEMO VEHICLE' : `${protocolName().toUpperCase()} DEVICE`;
    $('#unit-name').textContent = named || defaultName;
    $('#unit-id').textContent = `ESP32 · ${id || 'waiting for device ID'}`;
    const dataAge = model.lastMessageAt ? Date.now() - model.lastMessageAt : Infinity;
    const detail = state !== 'connected' ? state[0].toUpperCase() + state.slice(1)
      : demo ? 'Connected · simulated data'
      : !model.lastMessageAt ? 'Connected · waiting for device data'
      : dataAge > 15000 ? 'Connected · data is stale' : 'Connected · receiving data';
    $('#unit-status').textContent = `${protocolName()} · ${detail}`;
    const color = state === 'connected' ? 'var(--green)' : state === 'disconnected' ? 'var(--red)' : 'var(--amber)';
    $('#unit-dot').style.background = color;
    $('#unit-dot').style.boxShadow = `0 0 0 3px ${state === 'connected' ? '#16392e' : state === 'disconnected' ? '#402424' : '#41351f'}`;
    $('#unit-dot').classList.toggle('offline', state === 'disconnected');
    $('#unit-dot').classList.toggle('warning', state === 'connecting' || state === 'disconnecting');
  }

  function clearTelemetryForLiveWait() {
    model.telemetry = null;
    model.lastMessageAt = null;
    model.lastGpsAt = null;
    model.acceleration = [];
    model.gyroscope = [];
    model.preEventBuffer = [];
    model.currentEventId = null;
    if (model.map) model.map.remove();
    model.map = null;
    model.mapMarker = null; model.mapTiles = null;
    $('#map-tile-error').hidden = true;
    $('#vehicle-state').textContent = 'Waiting';
    $('#vehicle-chip').textContent = '● WAITING';
    $('#vehicle-status-note').textContent = 'Waiting for ESP32 telemetry';
    $('#accident-state').textContent = 'No incident';
    $('#severity-chip').textContent = 'NO ALERT';
    $('#latest-event-time').textContent = '—';
    $('#speed-value').textContent = '—';
    $('#speed-chip').textContent = '—';
    $('#gps-state').textContent = 'Searching';
    $('#satellite-chip').textContent = '— sats';
    $('#gps-updated').textContent = '—';
    ['latitude', 'longitude', 'gps-speed', 'satellites'].forEach(id => { $(`#${id}`).textContent = '—'; });
    $('#map-placeholder').classList.remove('hidden');
    $('#map-overlay').classList.remove('visible');
    $('#open-map').disabled = true;
    ['axis-x', 'axis-y', 'axis-z'].forEach(id => { $(`#${id}`).textContent = '—'; });
    ['chart-line-a', 'chart-line-b', 'chart-line-c'].forEach(id => { $(`#${id}`).setAttribute('d', ''); });
    ['accel-chart', 'gyro-chart'].forEach(id => $$(`#${id} .chart-line`).forEach(line => line.setAttribute('d', '')));
    $('#accel-readings').innerHTML = '';
    $('#gyro-readings').innerHTML = '';
    $('#last-message').textContent = 'Waiting for telemetry';
    $('#sensor-updated').textContent = '—';
    $('#sensor-freshness').textContent = 'Waiting for data';
    $('#health-sensor').textContent = 'Waiting';
    $('#health-time').textContent = '—';
    $('#health-data-age').textContent = '—';
    $('#health-gps').textContent = 'Unavailable';
    $('#health-gps-quality').textContent = 'Not reported';
    $('#health-power-signal').textContent = 'Not reported';
    $('#alert-banner').classList.add('hidden');
    updateUnitCard();
  }

  function updateConnectionCounters() {
    $('#message-count').textContent = model.messageCount.toLocaleString();
    $('#error-count').textContent = model.errorCount.toLocaleString();
    $('#reconnect-count').textContent = model.reconnectCount.toLocaleString();
    $('#protocol-message-count').textContent = model.messageCount.toLocaleString();
    $('#protocol-error-count').textContent = model.errorCount.toLocaleString();
    $('#bench-received').textContent = model.messageCount.toLocaleString();
    $('#bench-errors').textContent = model.errorCount.toLocaleString();
  }

  function cleanPayload(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Message must be a JSON object.');
    // Support one common gateway envelope while keeping the device payload itself intact.
    const payload = input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload) ? { ...input.payload, ...input } : { ...input };
    delete payload.payload;
    if (!payload.message_type && !payload.vehicle_status && !payload.accident_state && !payload.gps && !payload.acceleration && !payload.gyroscope) {
      throw new Error('Message has no recognized telemetry fields.');
    }
    if (payload.gps && typeof payload.gps !== 'object') throw new Error('GPS must be an object.');
    if (payload.acceleration && typeof payload.acceleration !== 'object') throw new Error('Acceleration must be an object.');
    if (payload.gyroscope && typeof payload.gyroscope !== 'object') throw new Error('Gyroscope must be an object.');
    return payload;
  }

  function parseAndHandle(raw, protocol, topic) {
    let parsed;
    try {
      if (typeof raw === 'string') parsed = JSON.parse(raw.trim());
      else if (raw instanceof ArrayBuffer) parsed = JSON.parse(new TextDecoder().decode(raw).trim());
      else if (ArrayBuffer.isView(raw)) parsed = JSON.parse(new TextDecoder().decode(raw).trim());
      else parsed = raw;
      const payload = cleanPayload(parsed);
      handleMessage(payload, protocol, topic);
      return true;
    } catch (error) {
      model.errorCount += 1;
      updateConnectionCounters();
      if (protocol === 'demo') return false;
      showToast(`Message rejected: ${error.message}`);
      return false;
    }
  }

  function normalizedAccidentState(payload, previousState = 'NONE') {
    const raw = String(payload.accident_state || '').toUpperCase();
    const type = String(payload.message_type || '').toLowerCase();
    if (type.includes('cancel')) return 'CANCELLED';
    if (type.includes('ack')) return 'ACKNOWLEDGED';
    if (type.includes('alert_sent') || type.includes('sms_sent')) return 'ALERT_SENT';
    if (type.includes('confirm')) return 'CONFIRMED';
    if (type.includes('sos')) return 'SOS';
    if (raw === 'NONE' || raw === 'NORMAL') return 'NONE';
    if (raw === '') return previousState || 'NONE';
    if (['SUSPECTED', 'COUNTDOWN', 'CANCELLED', 'CONFIRMED', 'ALERT_SENT', 'ACKNOWLEDGED', 'SENSOR_ERROR', 'SOS'].includes(raw)) return raw;
    return raw;
  }

  function handleMessage(raw, protocol = model.protocol, topic = '') {
    const payload = cleanPayload(raw);
    const historicalSnapshot = model.preEventBuffer.slice(-10);
    model.messageCount += 1;
    model.lastMessageAt = Date.now();
    const gps = payload.gps || {};
    const prior = model.telemetry || {};
    const acceleration = payload.acceleration || prior.acceleration || {};
    const gyroscope = payload.gyroscope || prior.gyroscope || {};
    const gpsValid = gps.valid === undefined ? Boolean(finite(gps.latitude) !== null && finite(gps.longitude) !== null) : Boolean(gps.valid);
    const lat = finite(gps.latitude);
    const lon = finite(gps.longitude);
    const validCoords = gpsValid && lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
    const time = payload.timestamp && Number.isFinite(new Date(payload.timestamp).getTime()) ? new Date(payload.timestamp).toISOString() : new Date().toISOString();
    if (payload.device_id !== undefined && payload.device_id !== null && String(payload.device_id).trim()) model.deviceId = String(payload.device_id).trim();
    model.telemetry = {
      ...prior, ...payload, timestamp: time,
      vehicle_status: payload.vehicle_status || prior.vehicle_status || 'NORMAL',
      accident_state: normalizedAccidentState(payload, prior.accident_state), severity: payload.severity || prior.severity || 'NONE',
      speed_kmh: finite(payload.speed_kmh ?? gps.speed_kmh ?? prior.speed_kmh),
      speed_limit_kmh: finite(payload.speed_limit_kmh ?? prior.speed_limit_kmh) ?? SPEED_LIMIT_DEFAULT,
      acceleration, gyroscope, gps: { ...gps, valid: validCoords, latitude: validCoords ? lat : null, longitude: validCoords ? lon : null }
    };
    collectCalibrationSample(model.telemetry, Boolean(payload.acceleration && payload.gyroscope));
    if (validCoords) model.lastGpsAt = Date.now();
    pushPoint(model.acceleration, [finite(acceleration.x), finite(acceleration.y), finite(acceleration.z)]);
    pushPoint(model.gyroscope, [finite(gyroscope.x), finite(gyroscope.y), finite(gyroscope.z)]);
    model.eventIds = new Set(model.events.map(event => event.event_id));
    if (!model.cloudMode) updateIncidentFromMessage(payload, model.telemetry, historicalSnapshot);
    model.preEventBuffer.push({ at: time, speed_kmh: model.telemetry.speed_kmh, gps: validCoords ? { latitude: lat, longitude: lon, speed_kmh: finite(gps.speed_kmh) } : null, acceleration: { x: finite(acceleration.x), y: finite(acceleration.y), z: finite(acceleration.z) }, gyroscope: { x: finite(gyroscope.x), y: finite(gyroscope.y), z: finite(gyroscope.z) } });
    if (model.preEventBuffer.length > 60) model.preEventBuffer.shift();
    updateConnectionCounters();
    renderDashboard(topic);
    if (['bluetooth', 'websocket', 'mqtt'].includes(protocol)) updateBleDelivery(payload);
    else if (payload.benchmark && typeof payload.benchmark === 'object') updateBenchmark(payload.benchmark);
    $('#protocol-last-message').textContent = localTime();
  }

  function pushPoint(series, values) {
    series.push(values);
    if (series.length > MAX_POINTS) series.shift();
  }

  function collectCalibrationSample(data, hasCurrentSensors) {
    const capture = model.calibrationCapture;
    if (!capture || !hasCurrentSensors) return;
    if (finite(data.speed_kmh) !== null && Math.abs(finite(data.speed_kmh)) > 1) {
      stopCalibration('Stopped because the vehicle moved. Keep it still and try again.');
      return;
    }
    const sample = {
      acceleration: ['x', 'y', 'z'].map(axis => finite(data.acceleration?.[axis])),
      gyroscope: ['x', 'y', 'z'].map(axis => finite(data.gyroscope?.[axis]))
    };
    if (sample.acceleration.every(value => value !== null) && sample.gyroscope.every(value => value !== null)) {
      capture.samples.push(sample);
      renderCalibrationPanel();
    }
  }

  function stopCalibration(message) {
    clearInterval(model.calibrationTimer);
    model.calibrationTimer = null;
    model.calibrationCapture = null;
    model.calibrationMessage = message;
    renderCalibrationPanel();
  }

  function captureSensorBaseline() {
    if (model.protocol === 'demo' || !model.connected) {
      showToast('Connect the real ESP32 before capturing its sensor baseline.');
      return;
    }
    if (!model.lastMessageAt || Date.now() - model.lastMessageAt > 3000) {
      showToast('Wait for fresh ESP32 telemetry before calibration.');
      return;
    }
    if (finite(model.telemetry?.speed_kmh) !== null && Math.abs(finite(model.telemetry.speed_kmh)) > 1) {
      showToast('Keep the vehicle stationary to capture a sensor baseline.');
      return;
    }
    clearInterval(model.calibrationTimer);
    model.calibrationCapture = { startedAt: Date.now(), samples: [], deviceId: model.deviceId };
    model.calibrationMessage = 'Capturing for 5 seconds. Keep the vehicle still.';
    renderCalibrationPanel();
    model.calibrationTimer = setInterval(() => {
      const capture = model.calibrationCapture;
      if (!capture) return;
      const remaining = Math.max(0, 5 - Math.floor((Date.now() - capture.startedAt) / 1000));
      if (!model.lastMessageAt || Date.now() - model.lastMessageAt > 3000) {
        stopCalibration('Capture stopped because live sensor data stopped. Reconnect and try again.');
        return;
      }
      if (remaining > 0) {
        model.calibrationMessage = `Capturing · ${remaining}s · ${capture.samples.length} sensor samples`;
        renderCalibrationPanel();
        return;
      }
      clearInterval(model.calibrationTimer);
      model.calibrationTimer = null;
      model.calibrationCapture = null;
      if (capture.samples.length < 3) {
        model.calibrationMessage = 'Not enough fresh sensor samples. Check the ESP32 stream and try again.';
        renderCalibrationPanel();
        return;
      }
      const average = sensor => [0, 1, 2].map(axis => capture.samples.reduce((sum, sample) => sum + sample[sensor][axis], 0) / capture.samples.length);
      saveCalibration({ captured_at: new Date().toISOString(), device_id: capture.deviceId, samples: capture.samples.length, acceleration: average('acceleration'), gyroscope: average('gyroscope') });
      model.calibrationMessage = `Reference captured from ${capture.samples.length} live samples. It is saved in this browser only.`;
      renderCalibrationPanel();
      showToast('Sensor baseline saved locally. Firmware readings were not changed.');
    }, 200);
  }

  function renderCalibrationPanel() {
    const button = $('#capture-calibration');
    if (!button) return;
    const speed = finite(model.telemetry?.speed_kmh);
    button.disabled = model.protocol === 'demo' || !model.connected || !model.lastMessageAt || Date.now() - model.lastMessageAt > 3000 || (speed !== null && Math.abs(speed) > 1);
    if (model.calibrationCapture) $('#calibration-status').textContent = model.calibrationMessage || 'Capturing. Keep the vehicle still.';
    else if (model.calibration) $('#calibration-status').textContent = model.calibrationMessage || `Reference captured ${new Date(model.calibration.captured_at).toLocaleString()} · saved in this browser.`;
    else $('#calibration-status').textContent = model.calibrationMessage || (model.protocol === 'demo' || !model.connected ? 'Connect a live ESP32 and keep the vehicle stationary.' : speed !== null && Math.abs(speed) > 1 ? 'Stop the vehicle to capture a stationary reference.' : 'Ready when fresh telemetry is available.');
    if (model.calibration) {
      const format = values => values.map(value => Number(value).toFixed(2)).join(' · ');
      $('#calibration-readings').innerHTML = `<span>Accelerometer baseline · X/Y/Z</span><strong>${escapeHtml(format(model.calibration.acceleration || []))} m/s²</strong><span>Gyroscope baseline · X/Y/Z</span><strong>${escapeHtml(format(model.calibration.gyroscope || []))} °/s</strong>`;
    } else {
      $('#calibration-readings').innerHTML = '<span>Accelerometer baseline</span><strong>Not captured</strong><span>Gyroscope baseline</span><strong>Not captured</strong>';
    }
  }

  function resetMeasurements() {
    model.bleDelivery = new window.VtaasDeliveryWindow();
    model.bleRtts = []; model.bleLastRttAt = null;
    $('#bench-latency').textContent = '—'; $('#bench-delivery').textContent = '—';
    $('#bench-latency-label').textContent = 'LATENCY';
    $('#bench-latency-note').textContent = 'Requires a measured device benchmark';
    $('#bench-delivery-note').textContent = 'Requires sent and received message counters';
  }

  function updateBenchmark(benchmark) {
    const latency = finite(benchmark.latency_ms);
    const received = finite(benchmark.received_messages);
    const sent = finite(benchmark.sent_messages);
    if (latency !== null && latency >= 0) {
      $('#bench-latency').textContent = `${Math.round(latency)} ms`;
      $('#bench-latency-note').textContent = 'Reported by device benchmark';
    }
    if (received !== null && sent !== null && sent > 0 && received >= 0 && received <= sent) {
      $('#bench-delivery').textContent = `${(received / sent * 100).toFixed(1)}%`;
      $('#bench-delivery-note').textContent = `${received} received / ${sent} sent · device benchmark`;
    }
  }

  function updateBleDelivery(payload) {
    const result = model.bleDelivery.observe(payload);
    if (!result) return;
    $('#bench-delivery').textContent = `${(100 * result.received / result.expected).toFixed(1)}%`;
    $('#bench-delivery-note').textContent = `${result.received} unique / ${result.expected} expected between first and latest frames · ${result.missing} missing`;
  }

  function stopBleProbes() {
    clearInterval(model.bleProbeTimer); model.bleProbeTimer = null;
    model.bleProbe = null; model.bleProbePending = null;
  }

  async function sendBleProbe() {
    const probe = model.bleProbe;
    if (!probe || !model.bleServer?.connected) return;
    const now = performance.now();
    if (model.bleLastRttAt !== null && now - model.bleLastRttAt > 12000) {
      model.bleRtts = []; model.bleLastRttAt = null;
      $('#bench-latency').textContent = '—';
      $('#bench-latency-note').textContent = 'No recent ping reply';
    }
    if (model.bleProbePending && now - model.bleProbePending.started < 4000) return;
    if (model.bleProbePending) $('#bench-latency-note').textContent = 'Previous ping timed out · retrying';
    const id = ++model.bleProbeId >>> 0;
    const packet = new Uint8Array([80, 73, 78, 71, 0, 0, 0, 0]);
    new DataView(packet.buffer).setUint32(4, id, true);
    model.bleProbePending = { id, started: now };
    try { await probe.writeValueWithResponse(packet); }
    catch {
      if (model.bleProbe !== probe) return;
      stopBleProbes();
      $('#bench-latency').textContent = '—';
      $('#bench-latency-note').textContent = 'Ping write failed · reconnect to retry';
    }
  }

  function acceptBlePong(payload) {
    if (payload?.message_type !== 'benchmark_pong') return false;
    const pending = model.bleProbePending;
    if (!pending || payload.probe_id !== pending.id) return true;
    model.bleProbePending = null;
    const now = performance.now(), elapsed = now - pending.started;
    if (elapsed < 0 || elapsed >= 4000) return true;
    model.bleRtts.push(elapsed);
    if (model.bleRtts.length > 20) model.bleRtts.shift();
    model.bleLastRttAt = now;
    const average = model.bleRtts.reduce((sum, value) => sum + value, 0) / model.bleRtts.length;
    $('#bench-latency').textContent = `${Math.round(average)} ms`;
    $('#bench-latency-note').textContent = `Mean of ${model.bleRtts.length} recent ping replies · includes device handling · not one-way delay`;
    return true;
  }

  function stopNetworkProbes() {
    clearInterval(model.networkProbeTimer); model.networkProbeTimer = null;
    model.networkProbeSend = null; model.networkProbePending = null;
    model.mqttProbeReplyTopic = null;
  }

  function startNetworkProbes(send, replyTopic = null) {
    stopNetworkProbes();
    model.mqttProbeReplyTopic = replyTopic;
    model.networkProbeSend = send;
    model.networkProbeSession = crypto.randomUUID(); model.networkProbeId = 0;
    model.networkRtts = []; model.networkLastRttAt = null;
    $('#bench-latency-label').textContent = 'LATENCY (ROUND TRIP)';
    $('#bench-latency').textContent = '—';
    $('#bench-latency-note').textContent = 'Waiting for ESP32 ping reply · sampled every 5 seconds';
    sendNetworkProbe();
    model.networkProbeTimer = setInterval(sendNetworkProbe, 5000);
  }

  function sendNetworkProbe() {
    if (!model.connected || !model.networkProbeSend) return;
    const now = performance.now();
    if (model.networkLastRttAt !== null && now - model.networkLastRttAt > 12000) {
      model.networkRtts = []; model.networkLastRttAt = null;
      $('#bench-latency').textContent = '—';
    }
    if (model.networkProbePending && now - model.networkProbePending.started < 4000) return;
    if (model.networkProbePending) $('#bench-latency-note').textContent = 'No ESP32 reply · check updated firmware and diagnostic topic permissions';
    const id = `${model.networkProbeSession}-${++model.networkProbeId}`;
    model.networkProbePending = { id, started: now };
    try {
      const result = model.networkProbeSend({ message_type: 'benchmark_ping', probe_id: id });
      // Some transports report send errors asynchronously.
      if (result?.catch) result.catch(() => {
        if (model.networkProbePending?.id === id) { model.networkProbePending = null; $('#bench-latency-note').textContent = 'Ping could not be sent · waiting for connection'; }
      });
    } catch {
      model.networkProbePending = null;
      $('#bench-latency-note').textContent = 'Ping could not be sent · waiting for connection';
    }
  }

  function acceptNetworkPong(payload) {
    if (payload?.message_type !== 'benchmark_pong') return false;
    const pending = model.networkProbePending;
    if (!pending || payload.probe_id !== pending.id) return true;
    model.networkProbePending = null;
    const now = performance.now(), elapsed = now - pending.started;
    if (elapsed < 0 || elapsed >= 4000) return true;
    model.networkRtts.push(elapsed);
    if (model.networkRtts.length > 20) model.networkRtts.shift();
    model.networkLastRttAt = now;
    const average = model.networkRtts.reduce((sum, value) => sum + value, 0) / model.networkRtts.length;
    $('#bench-latency').textContent = `${Math.round(average)} ms`;
    $('#bench-latency-note').textContent = `Mean of ${model.networkRtts.length} ESP32 round trips · includes ${model.protocol === 'mqtt' ? 'broker' : 'cloud relay'} and device handling · not one-way delay`;
    return true;
  }

  function startMqttProbes(client, telemetryTopic) {
    stopNetworkProbes();
    $('#bench-latency-label').textContent = 'LATENCY (ROUND TRIP)';
    // A single device prefix is needed; a terminal /# also includes its events.
    const suffix = telemetryTopic.endsWith('/telemetry') ? '/telemetry' : telemetryTopic.endsWith('/#') ? '/#' : null;
    const prefix = suffix ? telemetryTopic.slice(0, -suffix.length) : '';
    if (!prefix || /[+#]/.test(prefix)) {
      $('#bench-latency-note').textContent = 'For device ping, use a device topic ending in /telemetry or /#'; return;
    }
    const replyTopic = `${prefix}/benchmark/pong`;
    const generation = model.transportGeneration;
    client.subscribe(replyTopic, { qos: 0 }, (error, granted) => {
      if (model.mqtt !== client || generation !== model.transportGeneration || model.intentionalDisconnect) return;
      if (error || granted?.some(item => item.qos === 128)) {
        $('#bench-latency-note').textContent = 'Telemetry connected; allow subscription to the benchmark/pong topic for latency'; return;
      }
      startNetworkProbes(packet => new Promise((resolve, reject) => {
        if (model.mqtt !== client || !client.connected) { reject(new Error('Disconnected')); return; }
        client.publish(`${prefix}/benchmark/ping`, JSON.stringify(packet), { qos: 0, retain: false }, error => error ? reject(error) : resolve());
      }), replyTopic);
    });
  }

  function typeFrom(payload, telemetry) {
    const type = String(payload.message_type || '').toLowerCase();
    const accident = telemetry.accident_state;
    if (type.includes('sos') || accident === 'SOS') return 'sos';
    if (type.includes('overspeed') || (telemetry.speed_kmh !== null && telemetry.speed_kmh > telemetry.speed_limit_kmh)) return 'overspeed';
    if (accident === 'SUSPECTED' || accident === 'COUNTDOWN' || type.includes('accident_detected')) return 'accident';
    if (['CANCELLED', 'CONFIRMED', 'ALERT_SENT', 'ACKNOWLEDGED'].includes(accident) || type.includes('accident')) return 'accident';
    return null;
  }

  function statusFrom(telemetry, type) {
    if (type === 'sos') return 'SOS';
    if (type === 'overspeed') return 'Overspeed';
    return ({ SUSPECTED: 'Suspected', COUNTDOWN: 'Countdown', CANCELLED: 'Cancelled', CONFIRMED: 'Confirmed', ALERT_SENT: 'SMS sent', ACKNOWLEDGED: 'Acknowledged' })[telemetry.accident_state] || 'Suspected';
  }

  function estimateAccidentSeverity(speedKmh, decelerationMps2) {
    const speedBand = speedKmh >= 80 ? 3 : speedKmh >= 50 ? 2 : speedKmh >= 25 ? 1 : 0;
    const decelerationBand = decelerationMps2 >= 20 ? 3 : decelerationMps2 >= 12 ? 2 : decelerationMps2 >= 6 ? 1 : 0;
    return ['MINOR', 'MODERATE', 'SEVERE', 'CRITICAL'][Math.max(speedBand, decelerationBand)];
  }

  function updateIncidentFromMessage(payload, telemetry, historicalSnapshot = []) {
    const type = typeFrom(payload, telemetry);
    if (!type) return;
    const id = String(payload.event_id || (type === 'overspeed' ? `speed-${Math.floor(Date.now() / 30000)}` : `event-${Date.now()}`));
    const existing = model.events.find(event => event.event_id === id);
    const gps = telemetry.gps || {};
    const status = statusFrom(telemetry, type);
    const isNew = !existing;
    const preEvent = historicalSnapshot;
    const previousGps = preEvent.at(-1)?.gps;
    const crashSnapshot = existing?.crash_snapshot || {
      at: telemetry.timestamp,
      speed_kmh: finite(payload.crash_speed_kmh) ?? finite(preEvent.at(-1)?.speed_kmh) ?? telemetry.speed_kmh,
      gps: gps.valid ? { latitude: gps.latitude, longitude: gps.longitude } : previousGps ? { latitude: previousGps.latitude, longitude: previousGps.longitude } : null,
      acceleration: { x: finite(telemetry.acceleration?.x), y: finite(telemetry.acceleration?.y), z: finite(telemetry.acceleration?.z) },
      gyroscope: { x: finite(telemetry.gyroscope?.x), y: finite(telemetry.gyroscope?.y), z: finite(telemetry.gyroscope?.z) },
      crash: true
    };
    const horizontalAcceleration = Math.hypot(finite(crashSnapshot.acceleration.x) || 0, finite(crashSnapshot.acceleration.y) || 0);
    const previousSnapshot = preEvent.at(-1);
    const elapsedSeconds = previousSnapshot?.at ? (new Date(telemetry.timestamp).getTime() - new Date(previousSnapshot.at).getTime()) / 1000 : 0;
    const previousSpeed = finite(previousSnapshot?.speed_kmh);
    const eventSpeed = finite(payload.speed_kmh) ?? telemetry.speed_kmh;
    const speedDropDeceleration = elapsedSeconds > 0.1 && previousSpeed !== null && eventSpeed !== null
      ? Math.max(0, (previousSpeed - eventSpeed) / 3.6 / elapsedSeconds)
      : 0;
    const reportedDeceleration = finite(payload.deceleration_mps2);
    const decelerationMps2 = existing?.deceleration_mps2 ?? reportedDeceleration ?? Math.max(horizontalAcceleration, speedDropDeceleration);
    const decelerationSource = existing?.deceleration_source || (reportedDeceleration !== null ? (model.protocol === 'demo' ? 'Simulation: speed / 0.6 s stop' : payload.simulation === true ? (payload.deceleration_source || 'Simulator reported') : 'Device reported') : speedDropDeceleration > horizontalAcceleration ? 'Speed change estimate' : 'Accelerometer estimate');
    const estimatedSeverity = existing?.estimated_severity || estimateAccidentSeverity(crashSnapshot.speed_kmh || 0, decelerationMps2);
    let sensorHistory = existing?.sensor_history || [...preEvent.slice(-10), crashSnapshot];
    const eventStartedAt = new Date(existing?.timestamp || payload.timestamp || telemetry.timestamp).getTime();
    if (existing && Date.now() - eventStartedAt <= 15000 && Date.now() >= eventStartedAt && sensorHistory.at(-1)?.at !== telemetry.timestamp) {
      sensorHistory = [...sensorHistory, {
        at: telemetry.timestamp, speed_kmh: telemetry.speed_kmh,
        acceleration: { x: finite(telemetry.acceleration?.x), y: finite(telemetry.acceleration?.y), z: finite(telemetry.acceleration?.z) },
        gyroscope: { x: finite(telemetry.gyroscope?.x), y: finite(telemetry.gyroscope?.y), z: finite(telemetry.gyroscope?.z) }
      }].slice(-40);
    }
    const record = {
      event_id: id, type, status, severity: type === 'accident' ? estimatedSeverity : payload.severity || telemetry.severity || '—',
      estimated_severity: type === 'accident' ? estimatedSeverity : undefined,
      timestamp: existing?.timestamp || payload.timestamp || telemetry.timestamp,
      updated_at: telemetry.timestamp,
      latitude: existing?.latitude ?? (gps.valid ? gps.latitude : finite(previousGps?.latitude)),
      longitude: existing?.longitude ?? (gps.valid ? gps.longitude : finite(previousGps?.longitude)),
      speed_kmh: telemetry.speed_kmh, crash_speed_kmh: type === 'accident' ? crashSnapshot.speed_kmh : undefined,
      deceleration_mps2: type === 'accident' ? decelerationMps2 : undefined,
      deceleration_source: type === 'accident' ? decelerationSource : undefined,
      speed_limit_kmh: telemetry.speed_limit_kmh,
      message_type: payload.message_type || '', topic: topicOrNull(payload),
      sms_status: payload.sms_status || payload.delivery_status || payload.alert_delivery_status || existing?.sms_status || '',
      pre_event: existing?.pre_event || preEvent,
      crash_snapshot: type === 'accident' ? crashSnapshot : undefined,
      sensor_history: type === 'accident' ? sensorHistory : undefined,
      sequence: finite(payload.sequence ?? payload.seq), benchmark: payload.benchmark || undefined
    };
    model.currentEventId = id;
    if (existing) Object.assign(existing, record);
    else {
      model.events.unshift(record);
      if (model.events.length > 300) model.events.length = 300;
      model.eventIds.add(id);
    }
    if (telemetry.accident_state === 'SUSPECTED' || telemetry.accident_state === 'COUNTDOWN') {
      const countdown = finite(payload.countdown_remaining_s);
      if (countdown !== null) model.demoCountdown = Math.max(0, countdown);
      model.alertDismissed = false;
    }
    if (['CANCELLED', 'CONFIRMED', 'ALERT_SENT', 'ACKNOWLEDGED'].includes(telemetry.accident_state) || type === 'sos') model.alertDismissed = false;
    saveEvents();
  }

  function topicOrNull(payload) { return payload._topic || null; }

  function renderDashboard(topic = '') {
    const data = model.telemetry;
    if (!data) return;
    const state = data.accident_state;
    const speed = data.speed_kmh;
    const vehicleError = String(data.vehicle_status).toUpperCase() === 'SENSOR_ERROR' || String(data.vehicle_status).toUpperCase() === 'ERROR' || state === 'SENSOR_ERROR';
    const active = ['SUSPECTED', 'COUNTDOWN', 'CONFIRMED', 'ALERT_SENT', 'ACKNOWLEDGED', 'SOS'].includes(state);
    $('#vehicle-state').textContent = vehicleError ? 'Sensor error' : active ? 'Attention' : 'Normal';
    $('#vehicle-chip').textContent = vehicleError ? '● CHECK' : active ? '● ALERT' : '● ACTIVE';
    $('#vehicle-chip').className = `status-chip ${vehicleError ? 'status-red' : active ? 'status-amber' : 'status-green'}`;
    $('#vehicle-status-note').textContent = vehicleError ? 'Check sensor readings' : active ? 'Incident state received from device' : 'All systems operating';
    const stateLabels = { NONE: 'No incident', SUSPECTED: 'Suspected', COUNTDOWN: 'Countdown active', CANCELLED: 'Cancelled', CONFIRMED: 'Confirmed', ALERT_SENT: 'SMS sent', ACKNOWLEDGED: 'Acknowledged', SENSOR_ERROR: 'Sensor error', SOS: 'Manual SOS' };
    $('#accident-state').textContent = stateLabels[state] || (state ? state.replaceAll('_', ' ') : 'No incident');
    const severity = data.severity && String(data.severity).toUpperCase() !== 'NONE' ? String(data.severity).toUpperCase() : 'NO ALERT';
    $('#severity-chip').textContent = severity;
    $('#severity-chip').className = `status-chip ${['CONFIRMED', 'ALERT_SENT', 'ACKNOWLEDGED', 'SOS'].includes(state) ? 'status-red' : ['SUSPECTED', 'COUNTDOWN'].includes(state) ? 'status-amber' : 'status-neutral'}`;
    $('#latest-event-time').textContent = model.currentEventId ? shortTime(model.events.find(event => event.event_id === model.currentEventId)?.timestamp || data.timestamp) : '—';
    $('#speed-value').textContent = speed === null ? '—' : round(speed, 1);
    $('#speed-limit').textContent = `${round(data.speed_limit_kmh, 0)} km/h`;
    const overspeed = speed !== null && speed > data.speed_limit_kmh;
    $('#speed-chip').textContent = overspeed ? 'OVERSPEED' : 'NORMAL';
    $('#speed-chip').className = `status-chip ${overspeed ? 'status-red' : 'status-neutral'}`;
    const gps = data.gps || {};
    $('#gps-state').textContent = gps.valid ? 'Valid fix' : 'Unavailable';
    $('#gps-state').className = gps.valid ? '' : 'muted-text';
    $('#satellite-chip').textContent = `${safeText(gps.satellites, '—')} sats`;
    $('#latitude').textContent = gps.valid ? round(gps.latitude, 6) : '—';
    $('#longitude').textContent = gps.valid ? round(gps.longitude, 6) : '—';
    $('#gps-speed').textContent = gps.valid && finite(gps.speed_kmh) !== null ? `${round(finite(gps.speed_kmh), 1)} km/h` : '—';
    $('#satellites').textContent = gps.valid ? safeText(gps.satellites) : '—';
    $('#gps-updated').textContent = model.lastGpsAt ? localTime(new Date(model.lastGpsAt)) : '—';
    updateMap(gps);
    updateSensorReadings(data);
    updateAlert(data);
    drawAllCharts();
    renderRecentEvents();
    const date = model.lastMessageAt ? localTime(new Date(model.lastMessageAt)) : '—';
    $('#last-message').textContent = `Last message ${date}${topic ? ` · ${topic}` : ''}`;
    updateUnitCard();
    updateDeviceHealth(data, gps);
    $('#sensor-updated').textContent = date;
    $('#sensor-footer-time').textContent = `Last update ${date}`;
    const age = Date.now() - model.lastMessageAt;
    $('#sensor-freshness').textContent = !model.connected ? `Last reading · ${model.connectionState}` : age < 4000 ? 'Fresh' : age < 15000 ? 'Data aging' : 'Stale data';
    $('#sensor-freshness').style.color = !model.connected ? (model.connectionState === 'disconnected' ? 'var(--red)' : 'var(--amber)') : age < 4000 ? 'var(--green)' : age < 15000 ? 'var(--amber)' : 'var(--red)';
    const unitAccel = data.acceleration?.unit || 'm/s²';
    const unitGyro = data.gyroscope?.unit || '°/s';
    $('#chart-units').textContent = model.chartMode === 'accel' ? unitAccel : unitGyro;
    $('#accel-unit').textContent = unitAccel;
    $('#gyro-unit').textContent = unitGyro;
    renderCalibrationPanel();
  }

  function updateDeviceHealth(data = model.telemetry || {}, gps = data.gps || {}) {
    const age = model.lastMessageAt ? Date.now() - model.lastMessageAt : Infinity;
    const axes = sensor => ['x', 'y', 'z'].every(axis => finite(sensor?.[axis]) !== null);
    const hasMotionData = axes(data.acceleration) && axes(data.gyroscope);
    $('#health-sensor').textContent = model.protocol === 'demo' ? 'Simulated' : !model.lastMessageAt ? 'Waiting' : age >= 15000 ? 'Stale' : age >= 4000 ? 'Delayed' : hasMotionData ? 'Live' : 'Partial data';
    $('#health-time').textContent = model.lastMessageAt ? localTime(new Date(model.lastMessageAt)) : '—';
    $('#health-data-age').textContent = model.lastMessageAt ? ageLabel(age) : '—';
    $('#health-gps').textContent = model.protocol === 'demo' && gps.valid ? 'Simulated fix' : gps.valid ? 'Valid fix' : 'Unavailable';
    const accuracy = finite(gps.accuracy_m ?? gps.horizontal_accuracy_m ?? gps.gps_accuracy_m);
    const hdop = finite(gps.hdop);
    $('#health-gps-quality').textContent = accuracy !== null ? `±${round(accuracy, 1)} m` : hdop !== null ? `HDOP ${round(hdop, 1)}` : 'Not reported';
    const batteryPercent = finite(data.battery_percent);
    const batteryVolts = finite(data.battery_v ?? data.battery_voltage_v);
    const rssi = finite(data.wifi_rssi_dbm ?? data.rssi_dbm ?? data.signal_dbm ?? data.rssi);
    const power = batteryPercent !== null ? `${round(batteryPercent, 0)}% battery` : batteryVolts !== null ? `${round(batteryVolts, 2)} V battery` : null;
    const signal = rssi !== null ? `${round(rssi, 0)} dBm` : null;
    $('#health-power-signal').textContent = [power, signal].filter(Boolean).join(' · ') || 'Not reported';
  }

  function ageLabel(ms) {
    if (ms < 2000) return 'Just now';
    return `${Math.floor(ms / 1000)}s ago`;
  }

  function demoRoadPosition(distance) {
    let remaining = ((distance % DEMO_ROUTE_LENGTH) + DEMO_ROUTE_LENGTH) % DEMO_ROUTE_LENGTH;
    for (const segment of DEMO_ROUTE_SEGMENTS) {
      if (remaining <= segment.length) {
        const fraction = segment.length ? remaining / segment.length : 0;
        return [
          segment.from[0] + (segment.to[0] - segment.from[0]) * fraction,
          segment.from[1] + (segment.to[1] - segment.from[1]) * fraction
        ];
      }
      remaining -= segment.length;
    }
    return DEMO_ROAD_ROUTE[0];
  }

  function demoRoadHeading(distance, lookAheadMeters = 12) {
    const [lon1, lat1] = demoRoadPosition(distance - lookAheadMeters / 2);
    const [lon2, lat2] = demoRoadPosition(distance + lookAheadMeters / 2);
    const lat1Rad = lat1 * Math.PI / 180;
    const lat2Rad = lat2 * Math.PI / 180;
    const deltaLon = (lon2 - lon1) * Math.PI / 180;
    const y = Math.sin(deltaLon) * Math.cos(lat2Rad);
    const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) - Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(deltaLon);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  function angleDifferenceDegrees(current, previous) {
    return ((current - previous + 540) % 360) - 180;
  }

  function updateMap(gps) {
    const placeholder = $('#map-placeholder'), overlay = $('#map-overlay');
    const lat = finite(gps.latitude), lon = finite(gps.longitude);
    const valid = gps.valid && lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
    if (!valid) {
      placeholder.classList.remove('hidden'); overlay.classList.remove('visible');
      $('#map-tile-error').hidden = true;
      $('#open-map').disabled = true; $('#open-map').onclick = null;
      return;
    }
    $('#map-location-label').textContent = model.protocol === 'demo' ? 'DEMO LOCATION' : model.telemetry?.simulation === true ? (model.connected ? 'SIMULATED LOCATION' : 'LAST SIMULATED LOCATION') : model.connected ? 'LIVE LOCATION' : 'LAST LOCATION';
    $('#open-map').disabled = false;
    $('#open-map').onclick = () => window.open(`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}`, '_blank', 'noopener');
    // Never create or pan a Leaflet map inside display:none or a zero-size panel.
    // Returning to Overview / ResizeObserver will apply the latest GPS fix.
    if (!mapIsVisible()) return;
    if (!window.L) {
      placeholder.classList.add('hidden'); overlay.classList.remove('visible');
      $('#map-tile-error').hidden = false;
      return;
    }
    placeholder.classList.add('hidden'); overlay.classList.add('visible');
    const position = [lat, lon];
    if (!model.map) {
      const map = L.map('map-canvas', {
        zoomControl: true, attributionControl: true, scrollWheelZoom: false,
        zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false
      }).setView(position, 16);
      model.map = map;
      const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, updateWhenIdle: true, keepBuffer: 2,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      });
      model.mapTiles = tiles;
      tiles.on('tileerror', () => { if (model.map === map) $('#map-tile-error').hidden = false; });
      tiles.on('load', () => {
        if (model.map !== map) return;
        const images = [...tiles.getContainer().querySelectorAll('img.leaflet-tile')];
        if (images.length && images.every(image => image.complete && image.naturalWidth > 0)) $('#map-tile-error').hidden = true;
      });
      tiles.addTo(map);
      model.mapMarker = L.circleMarker(position, {
        radius: 8, color: '#eafff4', weight: 3, fillColor: '#35d995', fillOpacity: 1
      }).addTo(map).bindTooltip(model.protocol === 'demo' ? 'Demo vehicle' : model.telemetry?.device_name || 'Vehicle', { direction: 'top', offset: [0, -8] });
      invalidateMapSize();
    } else if (model.mapMarker) {
      model.mapMarker.setLatLng(position);
      if (!model.map.getBounds().pad(-0.25).contains(position)) model.map.setView(position, model.map.getZoom(), { animate: false });
    }
  }

  function retryMapTiles() {
    if (!mapIsVisible() || !model.telemetry?.gps?.valid) return;
    $('#map-tile-error').hidden = true;
    if (model.mapTiles) { model.map.invalidateSize({ pan: false }); model.mapTiles.redraw(); }
    else { updateMap(model.telemetry.gps); }
  }

  function updateSensorReadings(data) {
    const accel = data.acceleration || {}, gyro = data.gyroscope || {};
    $('#axis-x').textContent = round(finite(model.chartMode === 'accel' ? accel.x : gyro.x), 2);
    $('#axis-y').textContent = round(finite(model.chartMode === 'accel' ? accel.y : gyro.y), 2);
    $('#axis-z').textContent = round(finite(model.chartMode === 'accel' ? accel.z : gyro.z), 2);
    $('#accel-readings').innerHTML = axisCards(accel);
    $('#gyro-readings').innerHTML = axisCards(gyro);
  }

  function axisCards(reading) {
    return ['x', 'y', 'z'].map(axis => `<div class="axis-card"><span>${axis.toUpperCase()} AXIS</span><strong>${round(finite(reading[axis]), 2)}</strong></div>`).join('');
  }

  function drawAllCharts() {
    const accel = model.acceleration;
    const gyro = model.gyroscope;
    const miniSeries = model.chartMode === 'gyro' ? gyro : accel;
    const miniLimit = chartLimit(miniSeries);
    drawChart($('#mini-chart'), miniSeries, 500, 170, miniLimit);
    $('#chart-max').textContent = String(miniLimit);
    $('#chart-min').textContent = `−${miniLimit}`;
    $('#mini-chart').setAttribute('aria-label', `Live ${model.chartMode === 'gyro' ? 'gyroscope' : 'acceleration'} chart`);
    drawChart($('#accel-chart'), accel, 700, 210, chartLimit(accel));
    drawChart($('#gyro-chart'), gyro, 700, 210, chartLimit(gyro));
  }

  function chartLimit(points) {
    const peak = points.flat().reduce((max, value) => Math.max(max, Math.abs(finite(value) ?? 0)), 0);
    return Math.max(5, Math.ceil((peak * 1.2) / 5) * 5);
  }

  function drawChart(svg, points, width, height, limit) {
    if (!svg) return;
    const lines = $$('.chart-line', svg);
    const usable = points.slice(-MAX_POINTS);
    for (let axis = 0; axis < 3; axis += 1) {
      const path = usable.map((point, index) => {
        const value = finite(point[axis]);
        const x = usable.length <= 1 ? width : index / (usable.length - 1) * width;
        const y = value === null ? height / 2 : Math.max(4, Math.min(height - 4, height / 2 - (value / limit) * (height * 0.46)));
        return `${index ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
      }).join(' ');
      lines[axis].setAttribute('d', path);
    }
  }

  function updateAlert(data) {
    const banner = $('#alert-banner');
    const active = data.accident_state === 'SUSPECTED' || data.accident_state === 'COUNTDOWN';
    const terminal = ['CANCELLED', 'CONFIRMED', 'ALERT_SENT', 'ACKNOWLEDGED', 'SOS'].includes(data.accident_state);
    if (!active && !terminal) { banner.classList.add('hidden'); return; }
    if (model.alertDismissed) { banner.classList.add('hidden'); return; }
    banner.classList.remove('hidden');
    const title = ({ SUSPECTED: 'Accident suspected', COUNTDOWN: 'Accident confirmation countdown', CANCELLED: 'Accident cancelled', CONFIRMED: 'Accident confirmed', ALERT_SENT: 'Emergency SMS sent', ACKNOWLEDGED: 'Emergency alert acknowledged', SOS: 'Manual SOS received' })[data.accident_state] || 'Incident update';
    $('#alert-title').textContent = title;
    const delivery = data.sms_status || data.delivery_status || data.alert_delivery_status;
    $('#alert-copy').textContent = active ? `Severity ${data.severity || 'unclassified'} · remaining time reported by the ESP32.` : (delivery ? `Delivery status: ${formatDeliveryStatus(delivery)}` : `Event ${model.currentEventId || ''}`);
    $('#alert-countdown').textContent = active ? `${Math.max(0, finite(data.countdown_remaining_s) ?? model.demoCountdown)}s` : data.accident_state === 'CANCELLED' ? 'CANCELLED' : 'EVENT';
    $('#alert-countdown-label').textContent = active ? 'DEVICE COUNTDOWN' : 'EVENT STATUS';
    $('#cancel-alert').classList.toggle('hidden', !(active && model.protocol === 'demo'));
  }

  function eventLabel(event) { return event.status || 'Received'; }
  function eventClass(event) {
    if (event.type === 'sos') return 'sos';
    if (event.type === 'overspeed') return 'overspeed';
    const status = String(event.status).toLowerCase();
    if (status.includes('cancel')) return 'cancelled';
    if (status.includes('confirm') || status.includes('sms') || status.includes('ack')) return 'confirmed';
    if (status.includes('suspect') || status.includes('countdown')) return 'suspected';
    return 'accident';
  }

  function renderRecentEvents() {
    const root = $('#recent-events');
    const events = model.events.slice(0, 3);
    if (!events.length) { root.innerHTML = '<div class="no-events">No incidents received yet. Simulate an event to see the incident flow.</div>'; return; }
    root.innerHTML = events.map(event => `<div class="event-row"><span class="event-icon ${eventClass(event)}">${event.type === 'sos' ? 'SOS' : event.type === 'overspeed' ? '↗' : eventClass(event) === 'cancelled' ? '✓' : '!'}</span><div class="event-main"><strong>${escapeHtml(event.type === 'sos' ? 'Manual SOS' : event.type === 'overspeed' ? 'Overspeed alert' : `Accident ${event.status.toLowerCase()}`)}</strong><small>${escapeHtml(event.event_id)}</small></div><span class="event-severity">${escapeHtml(event.severity || '—')}</span><time class="event-time">${shortTime(event.timestamp)}</time><span class="event-tag ${eventClass(event)}">${escapeHtml(eventLabel(event))}</span></div>`).join('');
  }

  function renderHistory() {
    const query = ($('#history-search')?.value || '').trim().toLowerCase();
    const filter = $('#history-filter')?.value || 'all';
    const events = model.events.filter(event => {
      const matchesQuery = !query || `${event.event_id} ${event.status} ${event.type} ${event.severity}`.toLowerCase().includes(query);
      const matchesFilter = filter === 'all' || (filter === 'accident' && event.type === 'accident') || (filter === 'sos' && event.type === 'sos') || (filter === 'overspeed' && event.type === 'overspeed');
      return matchesQuery && matchesFilter;
    });
    $('#history-rows').innerHTML = events.map(event => {
      const location = event.latitude !== null && event.longitude !== null ? `${Number(event.latitude).toFixed(5)}, ${Number(event.longitude).toFixed(5)}` : 'GPS unavailable';
      return `<tr><td>${escapeHtml(event.event_id)}</td><td>${event.type === 'sos' ? 'Manual SOS' : event.type === 'overspeed' ? 'Overspeed' : 'Accident'}</td><td><span class="event-tag ${eventClass(event)}">${escapeHtml(eventLabel(event))}</span></td><td>${escapeHtml(formatDeliveryStatus(event.sms_status))}</td><td>${escapeHtml(event.severity || '—')}</td><td class="location-cell">${escapeHtml(location)}</td><td>${new Date(event.timestamp).toLocaleString()}</td><td><button class="evidence-link" data-evidence="${escapeAttribute(event.event_id)}">View package ↗</button></td></tr>`;
    }).join('');
    $('#history-empty').classList.toggle('hidden', events.length > 0);
    $('#history-total').textContent = model.events.length;
    $('#history-confirmed').textContent = model.events.filter(event => ['Confirmed', 'SMS sent', 'Acknowledged'].includes(event.status)).length;
    $('#history-cancelled').textContent = model.events.filter(event => event.status === 'Cancelled').length;
    $('#history-sos').textContent = model.events.filter(event => event.type === 'sos').length;
  }

  function formatDeliveryStatus(value) {
    if (value === null || value === undefined || String(value).trim() === '') return 'Not reported';
    const status = String(value).trim().replaceAll('_', ' ').replaceAll('-', ' ');
    return status.charAt(0).toUpperCase() + status.slice(1);
  }

  function mergeBufferedIncident(payload) {
    if (!payload || typeof payload !== 'object' || !payload.event_id) return false;
    const updatedAt = payload.updated_at || payload.timestamp;
    const updatedMs = new Date(updatedAt || 0).getTime();
    const clearedAt = Number(localStorage.getItem(HISTORY_CLEAR_KEY) || 0);
    if (Number.isFinite(updatedMs) && updatedMs <= clearedAt) return false;
    const id = String(payload.event_id);
    const existing = model.events.find(event => event.event_id === id);
    const rawState = String(payload.accident_state || '').toUpperCase();
    const typeText = String(payload.message_type || '').toLowerCase();
    const type = existing?.type || (typeText.includes('sos') || rawState === 'SOS' ? 'sos' : typeText.includes('overspeed') ? 'overspeed' : 'accident');
    const statusMap = { SUSPECTED: 'Suspected', COUNTDOWN: 'Countdown', CANCELLED: 'Cancelled', CONFIRMED: 'Confirmed', ALERT_SENT: 'SMS sent', ACKNOWLEDGED: 'Acknowledged', SOS: 'SOS' };
    const status = statusMap[rawState] || (type === 'sos' ? 'SOS' : type === 'overspeed' ? 'Overspeed' : existing?.status || 'Received');
    const gps = payload.gps && typeof payload.gps === 'object' ? payload.gps : {};
    const record = {
      ...existing, event_id: id, type, status,
      severity: payload.severity || existing?.severity || '—',
      timestamp: existing?.timestamp || payload.timestamp || updatedAt || new Date().toISOString(),
      updated_at: updatedAt || existing?.updated_at,
      latitude: finite(gps.latitude) ?? existing?.latitude ?? null,
      longitude: finite(gps.longitude) ?? existing?.longitude ?? null,
      speed_kmh: finite(payload.speed_kmh) ?? existing?.speed_kmh ?? null,
      speed_limit_kmh: finite(payload.speed_limit_kmh) ?? existing?.speed_limit_kmh ?? null,
      crash_speed_kmh: finite(payload.crash_speed_kmh) ?? existing?.crash_speed_kmh,
      deceleration_mps2: finite(payload.deceleration_mps2) ?? existing?.deceleration_mps2,
      deceleration_source: payload.deceleration_source || existing?.deceleration_source,
      sms_status: payload.sms_status || payload.delivery_status || payload.alert_delivery_status || existing?.sms_status || '',
      message_type: payload.message_type || existing?.message_type || '',
      pre_event: payload.pre_event || existing?.pre_event,
      crash_snapshot: payload.crash_snapshot || existing?.crash_snapshot,
      sensor_history: payload.sensor_history || existing?.sensor_history
    };
    const index = model.events.findIndex(event => event.event_id === id);
    if (index >= 0) model.events[index] = record;
    else model.events.unshift(record);
    model.events = model.events.slice(0, 300);
    saveEvents();
    return true;
  }

  async function syncBufferedEvents(webSocketUrl) {
    let url;
    try { url = new URL(webSocketUrl); } catch { return; }
    if (!url.pathname.endsWith('/ws')) return;
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    url.pathname = '/api/events';
    url.search = '';
    try {
      const response = await fetch(url, { mode: 'cors', credentials: 'omit' });
      if (!response.ok) throw new Error('Relay event sync failed.');
      const data = await response.json();
      const events = Array.isArray(data.events) ? data.events : [];
      events.forEach(mergeBufferedIncident);
      renderRecentEvents();
      renderHistory();
      $('#event-storage-status').textContent = `Saved in this browser · ${events.length} buffered relay event(s) checked`;
    } catch {
      $('#event-storage-status').textContent = 'Saved in this browser · relay backup unavailable';
    }
  }

  function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]); }
  function escapeAttribute(value) { return escapeHtml(value).replace(/`/g, '&#96;'); }

  function renderEvidenceSensorChart(samples, sensor, title, unit, limit) {
    const colors = ['#53d6a0', '#71b9ff', '#ffc76b'];
    const axes = ['x', 'y', 'z'];
    const width = 680, height = 150, left = 18, right = 18, top = 12, bottom = 22;
    const plotWidth = width - left - right, plotHeight = height - top - bottom;
    const markedCrashIndex = samples.findIndex(sample => sample.crash === true);
    const crashIndex = markedCrashIndex >= 0 ? markedCrashIndex : samples.length - 1;
    const xAt = index => left + (samples.length <= 1 ? plotWidth : index / (samples.length - 1) * plotWidth);
    const yAt = value => top + plotHeight / 2 - Math.max(-limit, Math.min(limit, value)) / limit * (plotHeight / 2);
    const grid = [-limit, 0, limit].map(value => `<line class="evidence-grid-line${value === 0 ? ' zero' : ''}" x1="${left}" y1="${yAt(value)}" x2="${width - right}" y2="${yAt(value)}" />`).join('');
    const lines = axes.map((axis, index) => {
      const points = samples.map((sample, pointIndex) => {
        const value = finite(sample[sensor]?.[axis]);
        return value === null ? null : `${xAt(pointIndex).toFixed(1)},${yAt(value).toFixed(1)}`;
      }).filter(Boolean).join(' ');
      if (!points) return '';
      const crashValue = finite(samples[crashIndex]?.[sensor]?.[axis]);
      const marker = crashValue === null ? '' : `<circle cx="${xAt(crashIndex)}" cy="${yAt(crashValue)}" r="3.5" fill="${colors[index]}" />`;
      return `<polyline points="${points}" fill="none" stroke="${colors[index]}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />${marker}`;
    }).join('');
    const legend = axes.map((axis, index) => `<span><i style="background:${colors[index]}"></i>${axis.toUpperCase()}</span>`).join('');
    return `<section class="evidence-chart"><div class="evidence-chart-heading"><strong>${title}</strong><span>${unit}</span></div><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${title} around the crash">${grid}<line class="evidence-crash-line" x1="${xAt(crashIndex)}" y1="${top}" x2="${xAt(crashIndex)}" y2="${height - bottom}" />${lines}</svg><div class="evidence-chart-legend">${legend}<span class="crash-legend">CRASH DETECTED</span></div></section>`;
  }

  function openEvidence(id) {
    const event = model.events.find(item => item.event_id === id);
    if (!event) return;
    clearEvidenceMap();
    const isOverspeed = event.type === 'overspeed';
    const locationTitle = isOverspeed ? 'Overspeed location' : 'Last location';
    const locationDescription = isOverspeed ? 'GPS fix at the overspeed event' : 'Latest valid GPS fix';
    const mapAriaLabel = isOverspeed ? 'Map of the overspeed location' : 'Map of the last known location';
    const location = event.latitude !== null && event.longitude !== null ? `${Number(event.latitude).toFixed(6)}, ${Number(event.longitude).toFixed(6)}` : 'GPS unavailable at event time';
    const hasCrashLocation = finite(event.latitude) !== null && finite(event.longitude) !== null;
    const crashSpeed = event.crash_speed_kmh ?? event.speed_kmh;
    const speed = crashSpeed === null || crashSpeed === undefined ? '—' : `${round(Number(crashSpeed), 1)} km/h`;
    const deceleration = event.deceleration_mps2 === null || event.deceleration_mps2 === undefined ? '—' : `${round(Number(event.deceleration_mps2), 1)} m/s²`;
    const sensorHistory = Array.isArray(event.sensor_history) ? event.sensor_history : [
      ...(Array.isArray(event.pre_event) ? event.pre_event : []), ...(event.crash_snapshot ? [event.crash_snapshot] : [])
    ];
    const eventDate = new Date(event.timestamp);
    const graphs = sensorHistory.length ? `${renderEvidenceSensorChart(sensorHistory, 'acceleration', 'Accelerometer history', 'm/s²', 40)}${renderEvidenceSensorChart(sensorHistory, 'gyroscope', 'Gyroscope history', '°/s', 250)}` : '';
    const locationMap = hasCrashLocation
      ? `<div id="evidence-location-map" class="evidence-location-map" role="application" aria-label="${mapAriaLabel}"></div>`
      : '<div class="evidence-location-map unavailable">No valid GPS position was recorded for this event.</div>';
    const speedLimit = finite(event.speed_limit_kmh) === null ? 'Not reported' : `${round(Number(event.speed_limit_kmh), 1)} km/h`;
    const speedLabel = isOverspeed ? 'SPEED AT OVERSPEED EVENT' : 'LAST RECORDED SPEED BEFORE IMPACT';
    const severityLabel = isOverspeed ? 'ALERT LEVEL' : 'ESTIMATED SEVERITY';
    const crashMetrics = isOverspeed ? `<div><small>APPLICABLE SPEED LIMIT</small><strong>${escapeHtml(speedLimit)}</strong></div>` : `<div><small>ESTIMATED DECELERATION</small><strong>${escapeHtml(deceleration)}</strong></div><div><small>DECELERATION SOURCE</small><strong>${escapeHtml(event.deceleration_source || 'Unavailable')}</strong></div>`;
    const evidenceNote = isOverspeed
      ? 'Location shows the GPS fix recorded with the overspeed event. If the event message did not include valid GPS coordinates, the dashboard uses the most recent valid location available when it received the event.'
      : `${sensorHistory.length ? `${sensorHistory.length} sensor sample(s), including the crash reading, are saved with this event.` : 'No sensor history was recorded for this event.'} Severity is a prototype estimate using the higher of the speed and deceleration bands (25/50/80 km/h and 6/12/20 m/s²). Deceleration uses a reported value when available; otherwise it uses the higher estimate from speed change or horizontal accelerometer magnitude. Values marked “Not reported” were not sent by the ESP32.`;
    $('#evidence-content').innerHTML = `<div class="evidence-id mono">${escapeHtml(event.event_id)}</div><div class="evidence-grid"><div><small>EVENT STATUS</small><strong>${escapeHtml(event.status)}</strong></div><div><small>${severityLabel}</small><strong>${escapeHtml(event.severity || 'Unspecified')}</strong></div><div><small>EMERGENCY ALERT DELIVERY</small><strong>${escapeHtml(formatDeliveryStatus(event.sms_status))}</strong></div><div><small>EVENT TIME</small><strong>${escapeHtml(eventDate.toLocaleString())}</strong></div><div><small>${speedLabel}</small><strong>${escapeHtml(speed)}</strong></div>${crashMetrics}<div><small>${isOverspeed ? 'OVERSPEED LOCATION' : 'LAST LOCATION'}</small><strong>${escapeHtml(location)}</strong></div></div><section class="evidence-location"><div class="evidence-chart-heading"><strong>${locationTitle}</strong><span>${locationDescription}</span></div>${locationMap}</section>${graphs}<div class="evidence-note">${evidenceNote}</div>`;
    $('#evidence-modal').showModal();
    if (hasCrashLocation && window.L) {
      const position = [Number(event.latitude), Number(event.longitude)];
      model.evidenceMap = L.map('evidence-location-map', { zoomControl: false, scrollWheelZoom: false, dragging: false, doubleClickZoom: false, boxZoom: false, keyboard: false }).setView(position, 16);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      }).addTo(model.evidenceMap);
      L.circleMarker(position, { radius: 9, color: '#fff4f2', weight: 2, fillColor: '#ff625b', fillOpacity: 1 })
        .addTo(model.evidenceMap).bindTooltip(locationTitle, { permanent: true, direction: 'top', offset: [0, -8] });
      requestAnimationFrame(() => model.evidenceMap?.invalidateSize());
    }
  }

  function clearEvidenceMap() {
    if (model.evidenceMap) model.evidenceMap.remove();
    model.evidenceMap = null;
  }

  function printEvidenceReport() {
    const previousTitle = document.title;
    const eventId = $('#evidence-content .evidence-id')?.textContent || 'event';
    document.title = `VT&AAS Incident Report - ${eventId}`;
    window.addEventListener('afterprint', () => { document.title = previousTitle; }, { once: true });
    window.print();
  }

  function stopDemo() {
    clearInterval(model.demoInterval);
    model.demoInterval = null;
    clearInterval(model.demoCountdownInterval);
    model.demoCountdownInterval = null;
    model.demoAccidentActive = false;
    model.demoCrashGps = null;
    model.demoCountdown = 0;
    model.demoAccidentSeverity = 'NONE';
    model.demoOverspeedUntil = 0;
  }

  // Preview all upcoming corners and brake early enough to reach their target speed.
  function demoCruiseSpeed(distance) {
    let remaining = ((distance % DEMO_ROUTE_LENGTH) + DEMO_ROUTE_LENGTH) % DEMO_ROUTE_LENGTH;
    for (let i = 0; i < DEMO_ROUTE_SEGMENTS.length; i++) {
      const segment = DEMO_ROUTE_SEGMENTS[i];
      if (remaining <= segment.length) {
        // One direction of the long straight occasionally tests overspeed;
        // the return journey and shorter streets retain normal ~70 km/h cruise.
        return segment.length > 350 && i < DEMO_ROUTE_SEGMENTS.length / 2 ? 90 : 70;
      }
      remaining -= segment.length;
    }
    return 70;
  }

  function demoRoadTargetSpeed(distance, cruiseKmh = 70) {
    let end = 0, target = cruiseKmh;
    const bearing = segment => Math.atan2((segment.to[0] - segment.from[0]) * Math.cos(segment.from[1] * Math.PI / 180), segment.to[1] - segment.from[1]) * 180 / Math.PI;
    DEMO_ROUTE_SEGMENTS.forEach((segment, i) => {
      end += segment.length;
      const ahead = (end - distance + DEMO_ROUTE_LENGTH) % DEMO_ROUTE_LENGTH;
      if (ahead > 180) return;
      const next = DEMO_ROUTE_SEGMENTS[(i + 1) % DEMO_ROUTE_SEGMENTS.length];
      const angle = Math.abs(angleDifferenceDegrees(bearing(next), bearing(segment)));
      const cornerKmh = angle < 8 ? cruiseKmh : angle < 20 ? 55 : angle < 45 ? 40 : angle < 85 ? 28 : angle < 135 ? 18 : 10;
      // 2.8 m/s² planned braking, with a 12 m corner approach buffer.
      target = Math.min(target, Math.sqrt((cornerKmh / 3.6) ** 2 + 2 * 2.8 * Math.max(0, ahead - 12)) * 3.6);
    });
    return target;
  }

  function demoCrashReadings(elapsedSeconds) {
    const pulse = (time, center, width) => Math.exp(-(((time - center) / width) ** 2));
    const t = Math.max(0, elapsedSeconds);
    const impactScale = (model.demoCrashDeceleration || 0) / 28;
    return {
      acceleration: {
        // A short forward deceleration pulse, a smaller lateral response, and a vertical shock.
        x: -(model.demoCrashDeceleration || 0) * Math.exp(-t / 0.6),
        y: (model.demoCrashDeceleration || 0) * 0.2 * pulse(t, 0.16, 0.22),
        z: 9.81 + (model.demoCrashDeceleration || 0) * 0.4 * Math.exp(-t / 0.24),
        unit: 'm/s2'
      },
      gyroscope: {
        // Rotation follows the impact with a separate roll, pitch, and yaw response.
        x: impactScale * (220 * pulse(t, 0.3, 0.28) - 8 * Math.exp(-t / 0.4)),
        y: impactScale * (-210 * Math.exp(-t / 0.5) + 65 * pulse(t, 0.5, 0.24)),
        z: impactScale * (82 * Math.exp(-t / 0.65) + 190 * pulse(t, 0.55, 0.3)),
        unit: 'deg/s'
      }
    };
  }

  function startDemo(resetCounts = false) {
    if (!canStartProtocol()) return;
    const wasCloud = model.cloudMode;
    stopCloudListeners();
    model.cloudMode = false;
    if (wasCloud) {
      // Keep the simulator's browser-only history separate from Firebase events.
      model.events = loadEvents();
      model.eventIds = new Set(model.events.map(event => event.event_id));
      model.currentEventId = null;
      renderRecentEvents();
      renderHistory();
    }
    cleanupTransport();
    stopDemo();
    model.intentionalDisconnect = false;
    model.protocol = 'demo';
    model.protocolSelection = 'demo';
    beginProtocolSession();
    lockProtocol('demo');
    model.demoPreviousSpeed = null;
    model.demoPreviousHeading = null;
    model.demoPreviousRoll = null;
    model.demoPreviousPitch = null;
    model.demoLastMotionAt = null;
    if (resetCounts) { model.messageCount = 0; model.errorCount = 0; }
    setProtocolTab('demo');
    toggleProtocolConnectionState(true, 'Receiving sample telemetry');
    $('#selected-protocol-value').textContent = 'Demo';
    $('#disconnect-button').textContent = 'Stop demo';
    $('#event-storage-status').textContent = 'Demo events are saved only in this browser; Firebase is read-only in demo mode.';
    model.demoInterval = setInterval(demoTick, 850);
    demoTick();
  }

  function demoTick() {
    model.demoTime += 1;
    const t = model.demoTime;
    const now = Date.now();
    const isGpsLost = Date.now() < model.gpsUnavailableUntil;
    const isCancelled = Date.now() < model.demoCancelledUntil;
    const moving = !model.demoAccidentActive;
    const motionDt = model.demoLastMotionAt ? Math.max(0.1, Math.min(2, (now - model.demoLastMotionAt) / 1000)) : 0.85;
    const previousMps = model.demoPreviousSpeed ?? 0;
    const targetMps = demoRoadTargetSpeed(model.demoDistance, (Date.now() < (model.demoOverspeedUntil || 0) ? 90 : demoCruiseSpeed(model.demoDistance)) + 1.2 * Math.sin(t / 12)) / 3.6;
    const speedMps = moving ? Math.max(0, previousMps + Math.max(-2.8 * motionDt, Math.min(1.6 * motionDt, targetMps - previousMps))) : 0;
    const speed = speedMps * 3.6;
    const longitudinalAcceleration = model.demoPreviousSpeed === null ? 0 : (speedMps - model.demoPreviousSpeed) / motionDt;
    if (moving) model.demoDistance = (model.demoDistance + (previousMps + speedMps) * 0.5 * motionDt) % DEMO_ROUTE_LENGTH;
    const heading = demoRoadHeading(model.demoDistance);
    const yawRate = !moving || speedMps < 0.05 || model.demoPreviousHeading === null ? 0 : Math.max(-45, Math.min(45, angleDifferenceDegrees(heading, model.demoPreviousHeading) / motionDt));
    const lateralAcceleration = speedMps * yawRate * Math.PI / 180;
    // Suspension lean is a small fraction of force-equivalent tilt.
    const response = 1 - Math.exp(-motionDt / 0.45);
    const rollTarget = Math.atan2(lateralAcceleration * 0.2, 9.81) * 180 / Math.PI;
    const roll = (model.demoPreviousRoll ?? 0) + response * (rollTarget - (model.demoPreviousRoll ?? 0));
    const pitchTarget = Math.atan2(-longitudinalAcceleration * 0.15, 9.81) * 180 / Math.PI;
    const pitch = (model.demoPreviousPitch ?? 0) + response * (pitchTarget - (model.demoPreviousPitch ?? 0));
    const rollRate = model.demoPreviousRoll === null ? 0 : (roll - model.demoPreviousRoll) / motionDt;
    const pitchRate = model.demoPreviousPitch === null ? 0 : (pitch - model.demoPreviousPitch) / motionDt;
    const roadVibration = (speedMps > 0.05 ? 0.12 + speedMps * 0.012 : 0) * Math.sin(model.demoDistance / 2.5);
    model.demoPreviousSpeed = speedMps;
    model.demoPreviousHeading = heading;
    model.demoPreviousRoll = roll;
    model.demoPreviousPitch = pitch;
    model.demoLastMotionAt = now;
    const [routeLon, routeLat] = demoRoadPosition(model.demoDistance);
    const lon = model.demoAccidentActive && model.demoCrashGps ? model.demoCrashGps.longitude : routeLon;
    const lat = model.demoAccidentActive && model.demoCrashGps ? model.demoCrashGps.latitude : routeLat;
    const impactActive = Date.now() < model.demoImpactUntil;
    const crashReadings = impactActive ? demoCrashReadings((Date.now() - model.demoCountdownStarted) / 1000) : null;
    const accel = crashReadings?.acceleration || {
      // Longitudinal change follows speed; lateral force follows route curvature.
      x: longitudinalAcceleration,
      y: lateralAcceleration,
      z: 9.81 + roadVibration,
      unit: 'm/s2'
    };
    const gyro = crashReadings?.gyroscope || {
      // Roll and pitch rates follow force changes; yaw follows map heading.
      x: rollRate,
      y: pitchRate,
      z: yawRate,
      unit: 'deg/s'
    };
    const countdown = model.demoAccidentActive ? Math.max(0, Math.ceil((model.demoCountdownEndsAt - Date.now()) / 1000)) : 0;
    const state = isCancelled ? 'CANCELLED' : model.demoAccidentActive ? (countdown > 0 ? 'COUNTDOWN' : 'CONFIRMED') : 'NONE';
    if (state === 'CONFIRMED' && !model.demoConfirmed) {
      model.demoConfirmed = true;
      model.demoCountdown = 0;
      clearInterval(model.demoCountdownInterval);
      model.demoCountdownInterval = null;
    }
    const message = {
      device_id: 'DEMO-01', device_name: 'Demo vehicle', event_id: model.currentEventId || undefined,
      message_type: state === 'COUNTDOWN' ? 'accident_countdown' : state === 'CONFIRMED' ? 'accident_confirmed' : 'telemetry',
      timestamp: new Date().toISOString(), vehicle_status: 'NORMAL', accident_state: state,
      severity: state === 'NONE' ? 'NONE' : model.demoAccidentSeverity,
      countdown_remaining_s: state === 'COUNTDOWN' ? countdown : 0,
      speed_kmh: speed, speed_limit_kmh: 80, acceleration: accel, gyroscope: gyro,
      crash_speed_kmh: model.demoAccidentActive ? model.telemetry?.crash_speed_kmh : undefined,
      deceleration_mps2: model.demoAccidentActive ? model.telemetry?.deceleration_mps2 : undefined,
      gps: { valid: !isGpsLost, latitude: isGpsLost ? null : lat, longitude: isGpsLost ? null : lon, speed_kmh: speed, satellites: isGpsLost ? 0 : 8 }
    };
    parseAndHandle(message, 'demo');
  }

  function startSuspectedScenario() {
    clearInterval(model.demoCountdownInterval);
    model.demoCountdown = 15;
    model.demoCountdownStarted = Date.now();
    model.demoCountdownEndsAt = model.demoCountdownStarted + 15000;
    model.demoCancelledUntil = 0;
    model.demoConfirmed = false;
    model.demoAccidentActive = true;
    const gps = model.telemetry?.gps;
    model.demoCrashGps = gps?.valid ? { latitude: gps.latitude, longitude: gps.longitude } : null;
    model.demoImpactUntil = model.demoCountdownStarted + 2500;
    const crashSpeed = finite(model.telemetry?.speed_kmh) ?? 48.5;
    // Synthetic equivalent deceleration: speed change over a 0.6 s stop.
    const crashDeceleration = crashSpeed / 3.6 / 0.6;
    model.demoCrashDeceleration = crashDeceleration;
    model.demoAccidentSeverity = estimateAccidentSeverity(crashSpeed, crashDeceleration);
    model.currentEventId = `evt_${Date.now().toString(36)}`;
    const crashReadings = demoCrashReadings(0);
    const payload = {
      device_id: 'DEMO-01', device_name: 'Demo vehicle', event_id: model.currentEventId, message_type: 'accident_detected',
      timestamp: new Date().toISOString(), accident_state: 'COUNTDOWN', severity: model.demoAccidentSeverity, countdown_remaining_s: 15,
      speed_kmh: 0, crash_speed_kmh: crashSpeed, deceleration_mps2: crashDeceleration, deceleration_source: 'Simulation: speed / 0.6 s stop', speed_limit_kmh: SPEED_LIMIT_DEFAULT,
      acceleration: crashReadings.acceleration,
      gyroscope: crashReadings.gyroscope,
      gps: gps ? { ...gps, speed_kmh: 0 } : undefined
    };
    parseAndHandle(payload, 'demo');
    model.demoCountdownInterval = setInterval(() => {
      if (!model.demoAccidentActive || model.demoConfirmed) {
        clearInterval(model.demoCountdownInterval);
        model.demoCountdownInterval = null;
        return;
      }
      const remaining = Math.max(0, Math.ceil((model.demoCountdownEndsAt - Date.now()) / 1000));
      model.demoCountdown = remaining;
      const countdownNode = $('#alert-countdown');
      if (countdownNode && !$('#alert-banner').classList.contains('hidden')) countdownNode.textContent = `${remaining}s`;
      if (remaining === 0) {
        clearInterval(model.demoCountdownInterval);
        model.demoCountdownInterval = null;
        demoTick();
      }
    }, 100);
    showToast('Demo accident countdown started. You can cancel it from the alert banner.');
    displayPage('overview');
  }

  function cancelDemoEvent() {
    if (model.protocol !== 'demo' || !model.currentEventId) return;
    clearInterval(model.demoCountdownInterval);
    model.demoCountdownInterval = null;
    model.demoAccidentActive = false;
    model.demoCrashGps = null;
    model.demoCancelledUntil = Date.now() + 5000;
    model.demoCountdown = 0;
    model.demoConfirmed = false;
    parseAndHandle({ device_id: 'DEMO-01', device_name: 'Demo vehicle', event_id: model.currentEventId, message_type: 'accident_cancelled', timestamp: new Date().toISOString(), accident_state: 'CANCELLED', reason: 'DRIVER_CANCEL', severity: 'MODERATE', gps: model.telemetry?.gps }, 'demo');
    showToast('Demo event marked cancelled.');
  }

  function sendScenario(name) {
    if (model.protocol !== 'demo') { showToast('Switch to Demo to run sample scenarios.'); return; }
    switch (name) {
      case 'suspected': startSuspectedScenario(); break;
      case 'sos': {
        model.currentEventId = `sos_${Date.now().toString(36)}`;
        parseAndHandle({ device_id: 'DEMO-01', device_name: 'Demo vehicle', event_id: model.currentEventId, message_type: 'manual_sos', timestamp: new Date().toISOString(), accident_state: 'SOS', severity: 'EMERGENCY', gps: model.telemetry?.gps, speed_kmh: model.telemetry?.speed_kmh }, 'demo');
        showToast('Demo manual SOS event added to history.'); displayPage('overview'); break;
      }
      case 'overspeed': {
        model.demoOverspeedUntil = Date.now() + 120000;
        showToast('Overspeed test armed: accelerating where the road permits. An alert is recorded when actual simulated speed exceeds 80 km/h.'); displayPage('overview'); break;
      }
      case 'gps-loss': model.gpsUnavailableUntil = Date.now() + 12000; showToast('GPS fix will be unavailable for 12 seconds in demo mode.'); break;
    }
  }

  function freezeMeasurements() {
    for (const metric of ['latency', 'delivery']) {
      if ($(`#bench-${metric}`).textContent === '—') continue;
      const note = $(`#bench-${metric}-note`);
      if (!note.textContent.startsWith('Last result · disconnected. ')) {
        note.textContent = `Last result · disconnected. ${note.textContent}`;
      }
    }
  }

  function cleanupTransport({ preserveMeasurements = false, releaseLock = true } = {}) {
    stopBleProbes();
    stopNetworkProbes();
    clearTimeout(model.connectionTimer); model.connectionTimer = null;
    model.transportGeneration += 1;
    if (releaseLock) model.protocolLock = null;
    updateProtocolLock();
    if (preserveMeasurements) freezeMeasurements();
    else resetMeasurements();
    if (model.calibrationCapture) stopCalibration('Capture stopped because the device connection changed. Reconnect and try again.');
    // Do not let samples from a prior transport (especially the simulator) leak into
    // a new device's crash evidence or sensor charts.
    model.preEventBuffer = [];
    model.acceleration = [];
    model.gyroscope = [];
    clearTimeout(model.reconnectTimer);
    model.reconnectTimer = null;
    if (model.ws) { const socket = model.ws; model.ws = null; socket.onclose = null; socket.onerror = null; try { socket.close(); } catch {} }
    if (model.mqtt) { const client = model.mqtt; model.mqtt = null; try { client.end(true); } catch {} }
    if (model.bleCharacteristic) { try { model.bleCharacteristic.removeEventListener('characteristicvaluechanged', onBleValue); } catch {} }
    if (model.bleDevice) { try { model.bleDevice.removeEventListener('gattserverdisconnected', onBleDisconnect); } catch {} }
    if (model.bleDevice?.gatt?.connected) { try { model.bleDevice.gatt.disconnect(); } catch {} }
    model.bleDevice = null; model.bleServer = null; model.bleCharacteristic = null; model.bleBuffer = '';
  }

  function stopCloudListeners() {
    model.cloudUnsubscribers.splice(0).forEach(unsubscribe => {
      try { unsubscribe(); } catch (error) { console.warn('Could not stop a Firebase listener:', error); }
    });
  }

  function connectWebSocket() {
    if (!canStartProtocol()) return;
    const url = $('#ws-url').value.trim();
    if (!/^wss?:\/\//i.test(url)) { showToast('Enter a WebSocket URL beginning with ws:// or wss://.'); return; }
    if ($('#ws-secure').checked && !url.startsWith('wss://')) { showToast('Secure WebSocket is required; use a wss:// URL.'); return; }
    cleanupTransport(); stopCloudListeners(); stopDemo(); model.cloudMode = false;
    model.protocol = 'websocket'; model.intentionalDisconnect = false; model.protocolSelection = 'websocket';
    beginProtocolSession();
    lockProtocol('websocket');
    setProtocolTab('websocket'); $('#selected-protocol-value').textContent = 'WebSocket';
    $('#disconnect-button').textContent = 'Disconnect';
    toggleProtocolConnectionState('connecting', 'Connecting to the WebSocket endpoint…');
    openWebSocket(url);
  }

  async function openWebSocket(url) {
    const generation = model.transportGeneration;
    if (model.intentionalDisconnect || model.protocol !== 'websocket') return;
    startConnectionDeadline('WebSocket connection timed out. Check the server and try again.');
    let firebaseIdToken = null;
    let hostedRelay = false;
    try { hostedRelay = new URL(url).hostname.endsWith('.workers.dev'); } catch {}
    if (hostedRelay) {
      if (!model.firebaseClient?.getIdToken) {
        failConnection('Sign in to VT&AAS before connecting to the hosted WebSocket relay.');
        showToast('Sign in to VT&AAS before using the hosted WebSocket relay.');
        return;
      }
      try { firebaseIdToken = await model.firebaseClient.getIdToken(); }
      catch { firebaseIdToken = null; }
      if (generation !== model.transportGeneration || model.intentionalDisconnect) return;
      if (!firebaseIdToken) {
        failConnection('Your VT&AAS sign-in expired. Sign in again and retry.');
        showToast('Your VT&AAS sign-in expired. Sign in again and retry.');
        return;
      }
    }
    if (generation !== model.transportGeneration || model.intentionalDisconnect) return;
    let socket;
    try { socket = new WebSocket(url); }
    catch (error) { model.errorCount += 1; updateConnectionCounters(); failConnection(error.message); showToast(`Could not connect: ${error.message}`); return; }
    model.ws = socket;
    let authenticated = !hostedRelay;
    socket.onopen = () => {
      if (model.ws !== socket || model.intentionalDisconnect) return;
      model.reconnectAttempt = 0;
      if (hostedRelay) {
        toggleProtocolConnectionState('connecting', 'Secure connection open · verifying VT&AAS sign-in…');
        socket.send(JSON.stringify({ type: 'auth', role: 'dashboard', token: firebaseIdToken, vehicle_id: model.deviceId || 'vehicle_01' }));
        return;
      }
      toggleProtocolConnectionState(true, `Connected to ${url}`);
      syncBufferedEvents(url);
      showToast('WebSocket connected. Waiting for telemetry.');
    };
    socket.onmessage = event => {
      if (model.ws !== socket || model.intentionalDisconnect) return;
      let control;
      try { control = JSON.parse(event.data); } catch {}
      if (control?.type === 'ready') return;
      if (acceptNetworkPong(control)) return;
      if (control?.type === 'auth_ok') {
        authenticated = true;
        toggleProtocolConnectionState(true, `Connected to secure VT&AAS WebSocket relay · ${url}`);
        if (control.benchmark === 'device_ping_v1') startNetworkProbes(packet => { if (model.ws !== socket || socket.readyState !== 1) throw new Error('Disconnected'); socket.send(JSON.stringify(packet)); });
        else $('#bench-latency-note').textContent = 'Device ping requires updated relay support';
        showToast('Secure WebSocket connected. Waiting for ESP32 telemetry.');
        return;
      }
      if (control?.type === 'error') {
        model.errorCount += 1;
        updateConnectionCounters();
        failConnection(`WebSocket authorization failed: ${control.error || 'request rejected'}`);
        showToast(`WebSocket authorization failed: ${control.error || 'request rejected'}`);
        socket.close(1008, 'Authorization failed.');
        return;
      }
      if (!authenticated) return;
      parseAndHandle(event.data, 'websocket');
    };
    socket.onerror = () => { if (model.ws !== socket || model.intentionalDisconnect) return; stopNetworkProbes(); model.errorCount += 1; updateConnectionCounters(); toggleProtocolConnectionState(false, 'WebSocket connection error. Check the URL and server.'); };
    socket.onclose = () => { if (model.ws !== socket || model.intentionalDisconnect) return; model.ws = null; stopNetworkProbes(); toggleProtocolConnectionState(false, 'WebSocket disconnected.'); if (!model.intentionalDisconnect && $('#ws-reconnect').checked) scheduleReconnect(() => openWebSocket(url)); };
  }

  function scheduleReconnect(callback) {
    clearTimeout(model.reconnectTimer);
    const wait = Math.min(30000, 1000 * (2 ** Math.min(model.reconnectAttempt, 5)));
    model.reconnectAttempt += 1; model.reconnectCount += 1; updateConnectionCounters();
    toggleProtocolConnectionState('connecting', `Reconnecting in ${Math.ceil(wait / 1000)}s…`);
    model.reconnectTimer = setTimeout(callback, wait);
  }

  function connectMqtt() {
    if (!canStartProtocol()) return;
    const url = $('#mqtt-url').value.trim();
    const topic = $('#mqtt-topic').value.trim();
    if (!/^wss?:\/\//i.test(url)) { showToast('Enter a broker WebSocket URL beginning with ws:// or wss://.'); return; }
    if (!topic) { showToast('Enter an MQTT topic or topic filter.'); return; }
    if (!window.mqtt || typeof window.mqtt.connect !== 'function') { showToast('MQTT.js could not load. Check internet access and reload the dashboard.'); return; }
    cleanupTransport(); stopCloudListeners(); stopDemo(); model.cloudMode = false;
    model.protocol = 'mqtt'; model.protocolSelection = 'mqtt'; model.intentionalDisconnect = false; model.reconnectAttempt = 0;
    beginProtocolSession();
    lockProtocol('mqtt');
    setProtocolTab('mqtt'); $('#selected-protocol-value').textContent = 'MQTT'; $('#disconnect-button').textContent = 'Disconnect';
    toggleProtocolConnectionState('connecting', 'Connecting to the MQTT broker…');
    startConnectionDeadline('MQTT connection timed out. Check the broker and credentials, then try again.');
    const options = { clientId: $('#mqtt-client').value.trim() || `vtaas_${Math.random().toString(16).slice(2, 10)}`, clean: true, connectTimeout: 10000, reconnectPeriod: $('#mqtt-reconnect').checked ? 2000 : 0 };
    if ($('#mqtt-user').value) options.username = $('#mqtt-user').value;
    if ($('#mqtt-password').value) options.password = $('#mqtt-password').value;
    try {
      const client = window.mqtt.connect(url, options);
      model.mqtt = client;
      client.on('connect', () => { if (model.mqtt !== client || model.intentionalDisconnect) return; model.reconnectAttempt = 0; toggleProtocolConnectionState('connecting', `Broker connected · subscribing to ${topic}`); client.subscribe(topic, { qos: 0 }, (error, granted) => { if (model.mqtt !== client || model.intentionalDisconnect) return; if (error || granted?.some(item => item.qos === 128)) { model.errorCount += 1; updateConnectionCounters(); failConnection('MQTT subscription failed. Check the topic permissions and try again.'); showToast(`Subscription failed: ${error?.message || 'topic rejected'}`); } else { toggleProtocolConnectionState(true, `Connected to MQTT broker · subscribed to ${topic}`); showToast('MQTT connected and subscribed.'); startMqttProbes(client, topic); } }); });
      client.on('message', (receivedTopic, bytes) => { if (model.mqtt !== client || model.intentionalDisconnect) return; const text = new TextDecoder().decode(bytes); try { const parsed = JSON.parse(text); if (receivedTopic === model.mqttProbeReplyTopic) { acceptNetworkPong(parsed); return; } if (parsed?.message_type === 'benchmark_ping' || parsed?.message_type === 'benchmark_pong') return; parsed._topic = receivedTopic; parseAndHandle(parsed, 'mqtt', receivedTopic); } catch (error) { model.errorCount += 1; updateConnectionCounters(); showToast(`Message rejected: ${error.message}`); } });
      client.on('reconnect', () => { if (model.mqtt !== client || model.intentionalDisconnect) return; stopNetworkProbes(); model.reconnectCount += 1; updateConnectionCounters(); toggleProtocolConnectionState('connecting', 'Reconnecting to the MQTT broker…'); startConnectionDeadline('MQTT reconnection timed out. Check the broker and try again.'); });
      client.on('close', () => { if (model.mqtt === client && !model.intentionalDisconnect) { stopNetworkProbes(); toggleProtocolConnectionState(false, 'MQTT connection closed.'); } });
      client.on('offline', () => { if (model.mqtt === client && !model.intentionalDisconnect) { stopNetworkProbes(); toggleProtocolConnectionState(false, 'MQTT broker offline.'); } });
      client.on('error', error => { if (model.mqtt !== client || model.intentionalDisconnect) return; model.errorCount += 1; updateConnectionCounters(); failConnection(`MQTT error: ${error.message}`); });
    } catch (error) { model.errorCount += 1; updateConnectionCounters(); failConnection(error.message); showToast(`Could not start MQTT: ${error.message}`); }
  }

  async function connectBluetooth() {
    if (!canStartProtocol()) return;
    if (!navigator.bluetooth) { showToast('Web Bluetooth is unavailable in this browser. Try Chrome on Android or desktop over HTTPS/localhost.'); return; }
    const serviceId = $('#ble-service').value.trim(); const characteristicId = $('#ble-characteristic').value.trim();
    if (!serviceId || !characteristicId) { showToast('Enter the BLE service and notify characteristic UUIDs from your firmware.'); return; }
    cleanupTransport(); stopCloudListeners(); stopDemo(); model.cloudMode = false; model.protocol = 'bluetooth'; model.protocolSelection = 'bluetooth'; model.intentionalDisconnect = false;
    beginProtocolSession();
    lockProtocol('bluetooth');
    setProtocolTab('bluetooth'); $('#selected-protocol-value').textContent = 'Bluetooth LE'; $('#disconnect-button').textContent = 'Disconnect';
    toggleProtocolConnectionState('connecting', 'Choose the ESP32 BLE device…');
    const generation = model.transportGeneration;
    const current = () => generation === model.transportGeneration && !model.intentionalDisconnect;
    try {
      const device = await navigator.bluetooth.requestDevice({ filters: [{ services: [serviceId] }], optionalServices: [serviceId] });
      if (!current()) return;
      startConnectionDeadline('Bluetooth connection timed out. Disconnect the ESP32 from other apps and try again.');
      model.bleDevice = device;
      device.addEventListener('gattserverdisconnected', onBleDisconnect);
      const server = await device.gatt.connect();
      if (!current()) { device.gatt.disconnect(); return; }
      model.bleServer = server;
      const service = await server.getPrimaryService(serviceId);
      const characteristic = await service.getCharacteristic(characteristicId);
      if (!current()) return;
      model.bleCharacteristic = characteristic;
      characteristic.addEventListener('characteristicvaluechanged', onBleValue);
      await characteristic.startNotifications();
      if (!current()) return;
      toggleProtocolConnectionState(true, `Connected to ${device.name || 'ESP32 BLE device'} · listening for JSON`);
      showToast('BLE connected. Send newline-delimited JSON from the ESP32.');
      $('#bench-latency-label').textContent = 'LATENCY (ROUND TRIP)';
      $('#bench-latency-note').textContent = 'Checking ESP32 ping support…';
      try {
        const probe = await service.getCharacteristic('6e400002-b5a3-f393-e0a9-e50e24dcca9e');
        if (!current()) return;
        model.bleProbe = probe;
        if (!model.bleProbe.properties.write) throw new Error('Ping writes unavailable');
        $('#bench-latency-note').textContent = 'Waiting for ping reply · sampled every 5 seconds';
        await sendBleProbe();
        if (!current()) return;
        model.bleProbeTimer = setInterval(sendBleProbe, 5000);
      } catch {
        if (!current()) return;
        stopBleProbes();
        $('#bench-latency-note').textContent = 'Upload the updated BLE sketch to enable ping replies';
      }
    } catch (error) {
      if (!current()) return;
      if (error.name !== 'NotFoundError') { model.errorCount += 1; updateConnectionCounters(); }
      failConnection(error.name === 'NotFoundError' ? 'Bluetooth selection cancelled. Choose a protocol to try again.' : `Bluetooth connection failed: ${error.message || 'Unknown error'}`);
    }
  }

  function onBleValue(event) {
    if (model.intentionalDisconnect) return;
    const value = event.target.value;
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    model.bleBuffer += new TextDecoder().decode(bytes, { stream: true });
    if (model.bleBuffer.length > BLE_BUFFER_LIMIT) { model.bleBuffer = ''; model.errorCount += 1; updateConnectionCounters(); showToast('BLE message buffer was reset because no line ending arrived.'); return; }
    const lines = model.bleBuffer.split(/\r?\n/); model.bleBuffer = lines.pop() || '';
    lines.map(line => line.trim()).filter(Boolean).forEach(line => {
      try { if (acceptBlePong(JSON.parse(line))) return; } catch {}
      parseAndHandle(line, 'bluetooth');
    });
  }

  function onBleDisconnect(event) {
    if (event?.target && event.target !== model.bleDevice) return;
    if (model.protocol !== 'bluetooth' || model.intentionalDisconnect) return;
    stopBleProbes();
    freezeMeasurements();
    model.bleServer = null; toggleProtocolConnectionState(false, 'BLE device disconnected.');
    if ($('#ws-reconnect').checked) { model.reconnectCount += 1; updateConnectionCounters(); showToast('BLE disconnected. Reconnect from the protocol panel.'); }
  }

  function waitForTransportClose() {
    const waits = [];
    if (model.ws && model.ws.readyState !== WebSocket.CLOSED) {
      const socket = model.ws;
      waits.push(new Promise(resolve => socket.addEventListener('close', resolve, { once: true })));
    }
    if (model.mqtt && !model.mqtt.disconnected) {
      const client = model.mqtt;
      waits.push(new Promise(resolve => client.once('end', resolve)));
    }
    if (model.bleDevice?.gatt?.connected) {
      waits.push(new Promise(resolve => model.bleDevice.addEventListener('gattserverdisconnected', resolve, { once: true })));
    }
    return Promise.all(waits);
  }

  async function disconnect() {
    if (model.connectionState === 'disconnecting') return;
    model.intentionalDisconnect = true;
    toggleProtocolConnectionState('disconnecting', `Disconnecting ${protocolName()}…`);
    stopBleProbes();
    // Stop immediately, including when the tab is in the background.
    const closed = waitForTransportClose();
    stopDemo(); stopCloudListeners(); model.cloudMode = false;
    cleanupTransport({ preserveMeasurements: true, releaseLock: false });
    let closeTimer;
    await Promise.race([closed, new Promise(resolve => { closeTimer = setTimeout(resolve, 5000); })]);
    clearTimeout(closeTimer);
    model.protocolLock = null; updateProtocolLock();
    toggleProtocolConnectionState('disconnected', `${protocolName()} disconnected. Last measurements are retained.`);
    showToast('Disconnected.');
  }

  async function loadAccount() {
    const firebase = await (window.vtaasFirebaseReady || Promise.resolve(null));
    if (firebase) {
      return new Promise(resolve => {
        let resolved = false;
        firebase.onAuthStateChanged(user => {
          if (!user) {
            if (!resolved) { resolved = true; window.location.replace('/login'); resolve(); }
            return;
          }
          if (resolved) return;
          resolved = true;
          $('#account-name').textContent = user.displayName || user.email || 'Account';
          $('#account-control').classList.remove('hidden');
          startCloudMode(firebase);
          resolve();
        });
      });
    }
    try {
      const response = await fetch('/api/auth/session', { cache: 'no-store' });
      if (response.status === 404) { $('#account-control').classList.add('hidden'); startDemo(); return; }
      if (!response.ok) { window.location.replace('/login'); return; }
      const result = await response.json();
      $('#account-name').textContent = result.user?.name || result.user?.email || 'Account';
      $('#account-control').classList.remove('hidden');
      startDemo();
    } catch {
      $('#account-name').textContent = 'Account status unavailable';
      startDemo();
    }
  }

  function startCloudMode(firebase) {
    if (!canStartProtocol()) return;
    stopCloudListeners();
    stopDemo();
    cleanupTransport();
    model.firebaseClient = firebase;
    model.cloudMode = true;
    model.protocol = 'firebase';
    beginProtocolSession();
    setProtocolTab('firebase');
    model.intentionalDisconnect = false;
    clearTelemetryForLiveWait();
    $('#selected-protocol-value').textContent = 'Firebase cloud';
    $('#protocol-last-message').textContent = 'Waiting for ESP32';
    $('#protocol-status-copy').textContent = 'Listening for ESP32 data from Firebase Realtime Database.';
    $('#protocol-title').textContent = 'Firebase cloud';
    $('#protocol-description').textContent = 'The dashboard reads live vehicle data from the cloud.';
    $('#protocol-badge').textContent = 'CLOUD';
    $('#big-connection-state').textContent = 'CLOUD CONNECTED';
    $('#event-storage-status').textContent = 'Incident history is shared through Firebase Realtime Database.';
    model.events = [];
    model.eventIds.clear();
    model.currentEventId = null;
    renderRecentEvents();
    renderHistory();
    toggleProtocolConnectionState(true, 'Listening to Firebase cloud data.');
    const vehicleId = firebase.config.vehicleId || 'vehicle_01';
    model.deviceId = vehicleId;
    model.cloudUnsubscribers.push(firebase.watchLatest(vehicleId, payload => {
      if (!model.cloudMode) return;
      if (!payload || typeof payload !== 'object') {
        toggleProtocolConnectionState(true, 'Firebase cloud connected · waiting for ESP32 data.');
        return;
      }
      try {
        handleMessage(payload, 'firebase');
        $('#protocol-last-message').textContent = localTime(new Date());
        toggleProtocolConnectionState(true, 'Receiving live data from Firebase.');
      } catch (error) {
        model.errorCount += 1; updateConnectionCounters();
        $('#protocol-status-copy').textContent = `Cloud data format error: ${error.message}`;
      }
    }, error => {
      model.errorCount += 1; updateConnectionCounters();
      toggleProtocolConnectionState(false, `Firebase read failed: ${error.message}`);
    }));
    model.cloudUnsubscribers.push(firebase.watchEvents(vehicleId, value => {
      if (!model.cloudMode) return;
      model.events = value && typeof value === 'object'
        ? Object.entries(value).map(([key, event]) => ({ ...event, event_id: event?.event_id || key })).filter(event => event && event.event_id).sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0)).slice(0, 300)
        : [];
      model.eventIds = new Set(model.events.map(event => event.event_id));
      renderRecentEvents(); renderHistory();
    }, error => {
      $('#event-storage-status').textContent = `Could not read cloud event history: ${error.message}`;
    }));
  }

  async function signOut() {
    $('#logout-button').disabled = true;
    const firebase = await (window.vtaasFirebaseReady || Promise.resolve(null));
    if (firebase) { await firebase.logout(); window.location.replace('/login'); return; }
    try { await fetch('/api/auth/logout', { method: 'POST' }); } catch {}
    window.location.replace('/login');
  }

  function exportCsv() {
    const headers = ['event_id', 'type', 'status', 'sms_status', 'severity', 'timestamp', 'latitude', 'longitude', 'speed_kmh', 'crash_speed_kmh', 'deceleration_mps2', 'deceleration_source', 'sensor_history_json'];
    const quote = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
    const rows = [headers, ...model.events.map(event => headers.map(key => key === 'sensor_history_json' ? JSON.stringify(event.sensor_history || []) : event[key] ?? ''))].map(row => row.map(quote).join(',')).join('\r\n');
    const blob = new Blob([rows], { type: 'text/csv;charset=utf-8' });
    const anchor = document.createElement('a'); anchor.href = URL.createObjectURL(blob); anchor.download = `vtaas-events-${new Date().toISOString().slice(0, 10)}.csv`; anchor.click(); URL.revokeObjectURL(anchor.href);
  }

  function init() {
    if ('ResizeObserver' in window) {
      model.mapResizeObserver = new ResizeObserver(() => invalidateMapSize());
      model.mapResizeObserver.observe($('#map-frame'));
    }
    window.addEventListener('resize', invalidateMapSize, { passive: true });
    $('#today-label').textContent = new Date().toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    $('#retry-map').addEventListener('click', retryMapTiles);
    $('#logout-button').addEventListener('click', signOut);
    $('#mqtt-client').value = `vtaas_${Math.random().toString(16).slice(2, 8)}`;
    $$('.nav-item').forEach(button => button.addEventListener('click', () => displayPage(button.dataset.page)));
    $$('[data-goto]').forEach(button => button.addEventListener('click', () => displayPage(button.dataset.goto)));
    $('#protocol-shortcut').addEventListener('click', () => {
      if (model.protocolLock !== null) { displayPage('protocols'); setProtocolTab(model.protocolLock); return; }
      if (model.protocol === 'demo' && model.firebaseClient) {
        startCloudMode(model.firebaseClient);
        displayPage('overview');
        showToast('Back to live Firebase mode. Waiting for ESP32 data.');
        return;
      }
      displayPage('protocols'); setProtocolTab(model.protocolSelection || 'websocket');
    });
    $$('.protocol-tab').forEach(button => button.addEventListener('click', () => { if (model.protocolLock !== null && button.dataset.protocol !== model.protocolLock) return; if (button.dataset.protocol === 'demo' && model.protocol !== 'demo') startDemo(); else setProtocolTab(button.dataset.protocol); }));
    $$('.connect-button').forEach(button => button.addEventListener('click', () => ({ websocket: connectWebSocket, mqtt: connectMqtt, bluetooth: connectBluetooth })[button.dataset.connect]()));
    $('#disconnect-button').addEventListener('click', () => { if (model.protocol === 'demo' && !model.demoInterval) startDemo(); else disconnect(); });
    $('#simulate-event').addEventListener('click', () => {
      if (model.protocolLock !== null && model.protocolLock !== 'demo') { canStartProtocol(); return; }
      if (model.protocol !== 'demo' || !model.demoInterval) {
        startDemo();
        displayPage('overview');
        showToast('Demo is running on this device only. Open Protocols to try accident, SOS or overspeed scenarios.');
      } else {
        displayPage('protocols'); setProtocolTab('demo');
        showToast('Choose an accident, SOS, overspeed or GPS scenario.');
      }
    });
    $$('[data-scenario]').forEach(button => button.addEventListener('click', () => sendScenario(button.dataset.scenario)));
    $$('.sensor-tab').forEach(button => button.addEventListener('click', () => { model.chartMode = button.dataset.chart; $$('.sensor-tab').forEach(tab => tab.classList.toggle('selected', tab === button)); if (model.telemetry) renderDashboard(); }));
    $('#dismiss-alert').addEventListener('click', () => { model.alertDismissed = true; $('#alert-banner').classList.add('hidden'); });
    $('#cancel-alert').addEventListener('click', cancelDemoEvent);
    $('#capture-calibration').addEventListener('click', captureSensorBaseline);
    $('#clear-calibration').addEventListener('click', () => { clearInterval(model.calibrationTimer); model.calibrationTimer = null; model.calibrationCapture = null; model.calibrationMessage = 'Local baseline cleared. Firmware readings were not changed.'; saveCalibration(null); });
    $('#print-evidence').addEventListener('click', printEvidenceReport);
    $('#evidence-modal').addEventListener('close', clearEvidenceMap);
    $('#history-search').addEventListener('input', renderHistory); $('#history-filter').addEventListener('change', renderHistory);
    $('#history-rows').addEventListener('click', event => { const button = event.target.closest('[data-evidence]'); if (button) openEvidence(button.dataset.evidence); });
    $('#close-evidence').addEventListener('click', () => $('#evidence-modal').close());
    $('#export-events').addEventListener('click', exportCsv);
    $('#clear-events').addEventListener('click', () => { if (!model.events.length || confirm('Clear event history saved in this browser? The relay’s backup remains on the computer but won’t be restored unless it is updated again.')) { model.events = []; model.currentEventId = null; model.eventIds.clear(); localStorage.setItem(HISTORY_CLEAR_KEY, String(Date.now())); saveEvents(); renderRecentEvents(); renderHistory(); showToast('Browser event history cleared.'); } });
    renderRecentEvents(); renderHistory(); renderCalibrationPanel(); updateUnitCard(); void loadAccount();
    setInterval(() => {
      if (model.telemetry) {
        const age = Date.now() - model.lastMessageAt;
        $('#sensor-freshness').textContent = !model.connected ? `Last reading · ${model.connectionState}` : age < 4000 ? 'Fresh' : age < 15000 ? 'Data aging' : 'Stale data';
        $('#sensor-freshness').style.color = !model.connected ? (model.connectionState === 'disconnected' ? 'var(--red)' : 'var(--amber)') : age < 4000 ? 'var(--green)' : age < 15000 ? 'var(--amber)' : 'var(--red)';
        updateDeviceHealth(); updateUnitCard(); renderCalibrationPanel();
        if (model.lastGpsAt && Date.now() - model.lastGpsAt > 15000 && model.telemetry.gps.valid) { model.telemetry.gps.valid = false; renderDashboard(); }
      }
    }, 1000);
  }

  init();
})();
