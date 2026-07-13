import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VIDEO_ID = 'dQw4w9WgXcQ';
const MEDIA = Buffer.from('abcdefghijklmnopqrstuvwxyz', 'ascii');
const RELAY_KEY = 'a'.repeat(64);

const mock = http.createServer((request, response) => {
  const url = new URL(request.url || '/', 'http://mock.invalid');
  if (url.pathname === '/api/v1/stats') {
    return json(response, 200, { software: { name: 'invidious', version: 'mock' } });
  }
  if (url.pathname === `/api/v1/videos/${VIDEO_ID}`) {
    return json(response, 200, {
      title: 'Mock video',
      formatStreams: [{
        itag: '18',
        type: 'video/mp4; codecs="avc1, mp4a"',
        container: 'mp4',
        url: `https://media.invalid/videoplayback?itag=18&clen=${MEDIA.length}`
      }]
    });
  }
  if (url.pathname === '/videoplayback') {
    // Deliberately ignore Range. The relay must still select the requested bytes.
    response.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': MEDIA.length
    });
    response.end(MEDIA);
    return;
  }
  if (url.pathname === `/vi/${VIDEO_ID}/mqdefault.jpg`) {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    response.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': jpeg.length });
    response.end(jpeg);
    return;
  }
  json(response, 404, { error: 'mock not found' });
});

const mockPort = await listenRandom(mock);
const relayPort = await findFreePort();
const relayPath = fileURLToPath(new URL('./server.mjs', import.meta.url));
let relayOutput = '';
const relay = spawn(process.execPath, [relayPath], {
  env: {
    ...process.env,
    PORT: String(relayPort),
    INVIDIOUS_INTERNAL_URL: `http://127.0.0.1:${mockPort}`,
    RELAY_KEY,
    API_TIMEOUT_MS: '5000',
    MEDIA_TIMEOUT_MS: '5000'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
relay.stdout.on('data', chunk => { relayOutput += chunk.toString(); });
relay.stderr.on('data', chunk => { relayOutput += chunk.toString(); });

const relayBase = `http://127.0.0.1:${relayPort}`;

try {
  await waitForHealth(`${relayBase}/health`);

  const health = await fetch(`${relayBase}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });

  const unauthorized = await fetch(`${relayBase}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: '/api/v1/stats', query: {} })
  });
  assert.equal(unauthorized.status, 401);

  const stats = await relayFetch('/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: '/api/v1/stats', query: {} })
  });
  assert.equal(stats.status, 200);
  assert.equal((await stats.json()).software.version, 'mock');

  const forbiddenPath = await relayFetch('/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'http://169.254.169.254/latest/meta-data', query: {} })
  });
  assert.equal(forbiddenPath.status, 400);

  const thumbnail = await relayFetch(`/media/thumb/${VIDEO_ID}/mqdefault`);
  assert.equal(thumbnail.status, 200);
  assert.equal(thumbnail.headers.get('content-type'), 'image/jpeg');
  assert.equal((await thumbnail.arrayBuffer()).byteLength, 4);

  const video = await relayFetch(`/media/video/${VIDEO_ID}/18`, {
    headers: { Range: 'bytes=5-9' }
  });
  assert.equal(video.status, 206);
  assert.equal(video.headers.get('content-range'), `bytes 5-9/${MEDIA.length}`);
  assert.equal(Buffer.from(await video.arrayBuffer()).toString('ascii'), 'fghij');

  const invalidRange = await relayFetch(`/media/video/${VIDEO_ID}/18`, {
    headers: { Range: 'bytes=10-5' }
  });
  assert.equal(invalidRange.status, 416);

  process.stdout.write('relay integration tests: ok\n');
} finally {
  relay.kill();
  await new Promise(resolve => mock.close(resolve));
}

async function relayFetch(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('X-Relay-Key', RELAY_KEY);
  return fetch(`${relayBase}${path}`, { ...options, headers });
}

function json(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': body.length });
  response.end(body);
}

function listenRandom(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function findFreePort() {
  const probe = http.createServer();
  const port = await listenRandom(probe);
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function waitForHealth(url) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (relay.exitCode !== null) throw new Error(`relay exited early:\n${relayOutput}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The process can need a few event-loop turns before it starts listening.
    }
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(`relay did not become healthy:\n${relayOutput}`);
}
