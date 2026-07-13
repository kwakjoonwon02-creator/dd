import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';

const PORT = integerEnv('PORT', 8080, 1, 65535);
const INVIDIOUS_INTERNAL_URL = new URL(process.env.INVIDIOUS_INTERNAL_URL || 'http://invidious:3000');
const RELAY_KEY = String(process.env.RELAY_KEY || '');
const API_TIMEOUT_MS = integerEnv('API_TIMEOUT_MS', 45000, 1000, 120000);
const MEDIA_TIMEOUT_MS = integerEnv('MEDIA_TIMEOUT_MS', 90000, 5000, 180000);
const MAX_RPC_BODY_BYTES = 64 * 1024;
const MAX_API_RESPONSE_BYTES = 6 * 1024 * 1024;
const MAX_THUMB_BYTES = 2 * 1024 * 1024;
const MAX_RANGE_BYTES = integerEnv('MAX_RANGE_BYTES', 1024 * 1024, 64 * 1024, 4 * 1024 * 1024);
const MAX_MEDIA_BYTES = integerEnv('MAX_MEDIA_BYTES', 1024 * 1024 * 1024, 10 * 1024 * 1024, 4 * 1024 * 1024 * 1024);
const REQUESTS_PER_MINUTE = integerEnv('REQUESTS_PER_MINUTE', 1200, 60, 10000);
const MAX_CONCURRENT_REQUESTS = integerEnv('MAX_CONCURRENT_REQUESTS', 48, 4, 256);
const VIDEO_CACHE_TTL_MS = 10 * 60 * 1000;

if (RELAY_KEY.length < 32 || /change|replace|paste/i.test(RELAY_KEY)) {
  throw new Error('RELAY_KEY must be a non-placeholder secret with at least 32 characters.');
}

const videoCache = new Map();
let activeRequests = 0;
let requestWindowStartedAt = Date.now();
let requestsInWindow = 0;

class PublicError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const server = http.createServer(async (request, response) => {
  setCommonHeaders(response);
  const requestUrl = new URL(request.url || '/', 'http://relay.invalid');

  if (request.method === 'GET' && requestUrl.pathname === '/health') {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (!isAuthorized(request.headers['x-relay-key'])) {
    sendJson(response, 401, { error: '인증되지 않은 릴레이 요청입니다.' });
    return;
  }
  if (!consumeRateBudget()) {
    sendJson(response, 429, { error: '릴레이 요청 한도를 잠시 초과했습니다.' });
    return;
  }
  if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
    sendJson(response, 503, { error: '릴레이가 처리 중입니다. 잠시 후 다시 시도하세요.' });
    return;
  }

  activeRequests += 1;
  try {
    if (request.method === 'POST' && requestUrl.pathname === '/rpc') {
      await handleRpc(request, response);
      return;
    }

    const thumbnailMatch = requestUrl.pathname.match(
      /^\/media\/thumb\/([A-Za-z0-9_-]{11})\/(default|mqdefault|hqdefault|sddefault|maxresdefault)$/
    );
    if (request.method === 'GET' && thumbnailMatch) {
      await handleThumbnail(response, thumbnailMatch[1], thumbnailMatch[2]);
      return;
    }

    const videoMatch = requestUrl.pathname.match(
      /^\/media\/video\/([A-Za-z0-9_-]{11})\/([0-9]{1,5})$/
    );
    if (request.method === 'GET' && videoMatch) {
      await handleVideoRange(request, response, videoMatch[1], videoMatch[2]);
      return;
    }

    sendJson(response, 404, { error: '허용되지 않은 릴레이 경로입니다.' });
  } catch (error) {
    const status = error instanceof PublicError ? error.status : 502;
    const message = error instanceof PublicError
      ? error.message
      : 'VPS 릴레이가 업스트림 요청을 처리하지 못했습니다.';
    if (!response.headersSent) {
      sendJson(response, status, { error: message });
    } else {
      response.destroy();
    }
    if (!(error instanceof PublicError)) {
      console.error(new Date().toISOString(), error && error.stack ? error.stack : error);
    }
  } finally {
    activeRequests -= 1;
  }
});

server.requestTimeout = 120000;
server.headersTimeout = 15000;
server.keepAliveTimeout = 5000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Protected Invidious relay listening on :${PORT}`);
});

async function handleRpc(request, response) {
  const rawBody = await readRequestBody(request, MAX_RPC_BODY_BYTES);
  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new PublicError(400, 'RPC JSON 본문이 올바르지 않습니다.');
  }

  const path = typeof payload.path === 'string' ? payload.path : '';
  if (!isAllowedApiPath(path)) {
    throw new PublicError(400, '허용되지 않은 Invidious API 경로입니다.');
  }
  const query = sanitizeApiQuery(payload.query);
  const upstreamUrl = new URL(path, INVIDIOUS_INTERNAL_URL);
  for (const [key, value] of Object.entries(query)) upstreamUrl.searchParams.set(key, value);

  const upstream = await fetch(upstreamUrl, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'Accept-Encoding': 'identity',
      'User-Agent': 'Invidious-GAS-Relay/1.0'
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(API_TIMEOUT_MS)
  });
  const body = await readFetchBody(upstream, MAX_API_RESPONSE_BYTES);
  const bodyText = body.toString('utf8');

  if (!upstream.ok) {
    throw new PublicError(normalizeUpstreamStatus(upstream.status), extractUpstreamError(bodyText));
  }
  try {
    JSON.parse(bodyText);
  } catch {
    throw new PublicError(502, 'Invidious가 JSON이 아닌 응답을 반환했습니다.');
  }

  response.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  response.end(body);
}

async function handleThumbnail(response, videoId, quality) {
  const upstreamUrl = new URL(`/vi/${videoId}/${quality}.jpg`, INVIDIOUS_INTERNAL_URL);
  const upstream = await fetch(upstreamUrl, {
    headers: {
      Accept: 'image/avif,image/webp,image/png,image/jpeg,*/*',
      'Accept-Encoding': 'identity',
      'User-Agent': 'Invidious-GAS-Relay/1.0'
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(API_TIMEOUT_MS)
  });
  if (!upstream.ok) {
    throw new PublicError(normalizeUpstreamStatus(upstream.status), '썸네일을 가져오지 못했습니다.');
  }

  const contentType = String(upstream.headers.get('content-type') || 'image/jpeg').split(';')[0];
  if (!/^image\/(?:jpeg|png|webp|avif)$/i.test(contentType)) {
    throw new PublicError(502, '썸네일 응답 형식이 이미지가 아닙니다.');
  }
  const body = await readFetchBody(upstream, MAX_THUMB_BYTES);
  response.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': body.length,
    'Cache-Control': 'private, max-age=600'
  });
  response.end(body);
}

async function handleVideoRange(request, response, videoId, itag) {
  const requested = parseRangeHeader(request.headers.range);
  let format = await getVideoFormat(videoId, itag, false);
  let total = format.totalBytes;

  if (total && requested.start >= total) {
    response.writeHead(416, {
      'Content-Range': `bytes */${total}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store'
    });
    response.end();
    return;
  }

  let end = requested.end;
  if (total) end = Math.min(end, total - 1);
  const wantedBytes = end - requested.start + 1;
  if (wantedBytes < 1 || wantedBytes > MAX_RANGE_BYTES) {
    throw new PublicError(416, `한 번에 요청할 수 있는 범위는 ${MAX_RANGE_BYTES}바이트 이하입니다.`);
  }

  let upstream = await fetchMedia(format.url, requested.start, end);
  if (upstream.status === 403 || upstream.status === 410) {
    videoCache.delete(videoId);
    format = await getVideoFormat(videoId, itag, true);
    total = format.totalBytes || total;
    upstream = await fetchMedia(format.url, requested.start, end);
  }

  if (upstream.status === 416) {
    const upstreamRange = parseContentRange(upstream.headers.get('content-range'));
    total = upstreamRange.total || total;
    response.writeHead(416, {
      'Content-Range': total ? `bytes */${total}` : 'bytes */*',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store'
    });
    response.end();
    return;
  }
  if (upstream.status !== 200 && upstream.status !== 206) {
    const errorBody = await readFetchBody(upstream, 64 * 1024).catch(() => Buffer.alloc(0));
    throw new PublicError(
      normalizeUpstreamStatus(upstream.status),
      extractUpstreamError(errorBody.toString('utf8')) || '영상 업스트림 요청이 실패했습니다.'
    );
  }
  if (!upstream.body) throw new PublicError(502, '영상 업스트림 응답 본문이 비어 있습니다.');

  const upstreamRange = parseContentRange(upstream.headers.get('content-range'));
  const upstreamStart = upstream.status === 206 ? upstreamRange.start : 0;
  if (upstreamStart > requested.start) {
    await upstream.body.cancel();
    throw new PublicError(502, '영상 업스트림이 잘못된 바이트 위치를 반환했습니다.');
  }

  total = upstreamRange.total || total || contentLengthForFullResponse(upstream);
  if (total > MAX_MEDIA_BYTES) {
    await upstream.body.cancel();
    throw new PublicError(413, 'VPS 릴레이의 최대 영상 크기를 넘습니다.');
  }

  const skipBytes = requested.start - upstreamStart;
  const selected = await collectSelectedBytes(upstream.body, skipBytes, wantedBytes);
  if (!selected.buffer.length) throw new PublicError(502, '영상 업스트림이 빈 바이트 범위를 반환했습니다.');

  const responseEnd = requested.start + selected.buffer.length - 1;
  if (!total && selected.ended) total = responseEnd + 1;
  const contentType = normalizeVideoContentType(
    upstream.headers.get('content-type') || format.mimeType
  );

  response.writeHead(206, {
    'Content-Type': contentType,
    'Content-Length': selected.buffer.length,
    'Content-Range': `bytes ${requested.start}-${responseEnd}/${total || '*'}`,
    'X-Video-Total': total ? String(total) : '',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store'
  });
  response.end(selected.buffer);
}

async function fetchMedia(url, start, end) {
  return fetch(url, {
    method: 'GET',
    headers: {
      Range: `bytes=${start}-${end}`,
      Accept: '*/*',
      'Accept-Encoding': 'identity',
      'User-Agent': 'Invidious-GAS-Relay/1.0'
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS)
  });
}

async function getVideoFormat(videoId, wantedItag, forceRefresh) {
  const formats = await getVideoFormats(videoId, forceRefresh);
  const format = formats.get(String(wantedItag));
  if (!format) throw new PublicError(404, '요청한 영상 형식을 찾지 못했습니다.');
  return format;
}

async function getVideoFormats(videoId, forceRefresh) {
  const now = Date.now();
  const cached = videoCache.get(videoId);
  if (!forceRefresh && cached && cached.expiresAt > now) return cached.value;

  const pending = fetchVideoFormats(videoId);
  videoCache.set(videoId, { expiresAt: now + VIDEO_CACHE_TTL_MS, value: pending });
  try {
    const formats = await pending;
    const resolved = Promise.resolve(formats);
    videoCache.set(videoId, { expiresAt: Date.now() + VIDEO_CACHE_TTL_MS, value: resolved });
    return resolved;
  } catch (error) {
    videoCache.delete(videoId);
    throw error;
  }
}

async function fetchVideoFormats(videoId) {
  const upstreamUrl = new URL(`/api/v1/videos/${videoId}`, INVIDIOUS_INTERNAL_URL);
  upstreamUrl.searchParams.set('local', 'true');
  upstreamUrl.searchParams.set('hl', 'ko');
  const upstream = await fetch(upstreamUrl, {
    headers: {
      Accept: 'application/json',
      'Accept-Encoding': 'identity',
      'User-Agent': 'Invidious-GAS-Relay/1.0'
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(API_TIMEOUT_MS)
  });
  const body = await readFetchBody(upstream, MAX_API_RESPONSE_BYTES);
  if (!upstream.ok) {
    throw new PublicError(normalizeUpstreamStatus(upstream.status), extractUpstreamError(body.toString('utf8')));
  }

  let data;
  try {
    data = JSON.parse(body.toString('utf8'));
  } catch {
    throw new PublicError(502, 'Invidious 영상 형식 응답이 JSON이 아닙니다.');
  }
  if (data.error) throw new PublicError(502, String(data.error).slice(0, 300));

  const formats = new Map();
  for (const raw of Array.isArray(data.formatStreams) ? data.formatStreams : []) {
    const itag = String(raw.itag || '');
    if (!/^[0-9]{1,5}$/.test(itag) || !raw.url) continue;
    const mediaUrl = rewriteMediaUrlToInternal(String(raw.url));
    const totalBytes = contentLengthFromMediaUrl(mediaUrl);
    if (totalBytes > MAX_MEDIA_BYTES) continue;
    formats.set(itag, {
      url: mediaUrl,
      totalBytes,
      mimeType: normalizeVideoContentType(raw.type || raw.mimeType || `video/${raw.container || 'mp4'}`)
    });
  }
  if (!formats.size) throw new PublicError(404, '이 영상에는 오디오가 포함된 점진적 형식이 없습니다.');
  return formats;
}

function rewriteMediaUrlToInternal(rawUrl) {
  const parsed = new URL(rawUrl, INVIDIOUS_INTERNAL_URL);
  if (!/^\/(?:videoplayback|latest_version)(?:\/|$)/.test(parsed.pathname)) {
    throw new PublicError(502, 'Invidious가 예상하지 않은 미디어 경로를 반환했습니다.');
  }
  return new URL(`${parsed.pathname}${parsed.search}`, INVIDIOUS_INTERNAL_URL);
}

function contentLengthFromMediaUrl(url) {
  const value = url.searchParams.get('clen') || url.searchParams.get('content_length') || '';
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function parseRangeHeader(value) {
  const match = String(value || '').match(/^bytes=(\d+)-(\d+)$/);
  if (!match) throw new PublicError(416, '단일 bytes 시작-끝 Range 헤더가 필요합니다.');
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    throw new PublicError(416, '영상 바이트 범위가 올바르지 않습니다.');
  }
  return { start, end };
}

function parseContentRange(value) {
  const match = String(value || '').match(/^bytes\s+(?:(\d+)-(\d+)|\*)\/(\d+|\*)$/i);
  return {
    start: match && match[1] ? Number(match[1]) : 0,
    end: match && match[2] ? Number(match[2]) : 0,
    total: match && match[3] && match[3] !== '*' ? Number(match[3]) : 0
  };
}

function contentLengthForFullResponse(response) {
  if (response.status !== 200) return 0;
  const value = Number(response.headers.get('content-length') || 0);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

async function collectSelectedBytes(body, skipBytes, wantedBytes) {
  const reader = body.getReader();
  const chunks = [];
  let skip = skipBytes;
  let remaining = wantedBytes;
  let ended = false;
  try {
    while (remaining > 0) {
      const result = await reader.read();
      if (result.done) {
        ended = true;
        break;
      }
      let chunk = Buffer.from(result.value);
      if (skip >= chunk.length) {
        skip -= chunk.length;
        continue;
      }
      if (skip > 0) {
        chunk = chunk.subarray(skip);
        skip = 0;
      }
      if (chunk.length > remaining) chunk = chunk.subarray(0, remaining);
      chunks.push(chunk);
      remaining -= chunk.length;
    }
  } finally {
    if (!ended) await reader.cancel().catch(() => {});
  }
  return { buffer: Buffer.concat(chunks), ended };
}

function isAllowedApiPath(path) {
  return [
    /^\/api\/v1\/stats$/,
    /^\/api\/v1\/(?:trending|popular|search|search\/suggestions)$/,
    /^\/api\/v1\/videos\/[A-Za-z0-9_-]{11}$/,
    /^\/api\/v1\/channels\/UC[A-Za-z0-9_-]{22}$/,
    /^\/api\/v1\/channels\/UC[A-Za-z0-9_-]{22}\/(?:videos|search)$/,
    /^\/api\/v1\/playlists\/[A-Za-z0-9_-]{10,100}$/
  ].some(pattern => pattern.test(path));
}

function sanitizeApiQuery(rawQuery) {
  if (rawQuery === undefined || rawQuery === null) return {};
  if (typeof rawQuery !== 'object' || Array.isArray(rawQuery)) {
    throw new PublicError(400, 'RPC query는 객체여야 합니다.');
  }

  const result = {};
  const rules = {
    q: value => limitedText(value, 120),
    page: value => integerText(value, 1, 50),
    type: value => enumText(value, ['all', 'video', 'channel', 'playlist', 'movie', 'show', 'music', 'gaming', 'movies', 'default']),
    sort: value => enumText(value, ['relevance', 'views']),
    sort_by: value => enumText(value, ['newest', 'popular', 'oldest', 'last']),
    date: value => enumText(value, ['hour', 'today', 'week', 'month', 'year']),
    duration: value => enumText(value, ['short', 'medium', 'long']),
    region: value => regexText(value, /^[A-Z]{2}$/),
    hl: value => regexText(value, /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/),
    local: value => enumText(String(value), ['true', 'false']),
    continuation: value => limitedText(value, 24000),
    features: value => regexText(value, /^[A-Za-z0-9_,]{1,120}$/)
  };

  for (const [key, value] of Object.entries(rawQuery)) {
    if (!Object.hasOwn(rules, key)) throw new PublicError(400, `허용되지 않은 API query 키입니다: ${key}`);
    result[key] = rules[key](value);
  }
  return result;
}

function limitedText(value, maxLength) {
  const text = String(value ?? '');
  if (!text || text.length > maxLength || /[\u0000-\u001F]/.test(text)) {
    throw new PublicError(400, 'API query 문자열 길이 또는 문자가 올바르지 않습니다.');
  }
  return text;
}

function integerText(value, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new PublicError(400, 'API query 숫자 범위가 올바르지 않습니다.');
  }
  return String(number);
}

function enumText(value, choices) {
  const text = String(value);
  if (!choices.includes(text)) throw new PublicError(400, 'API query 선택값이 올바르지 않습니다.');
  return text;
}

function regexText(value, pattern) {
  const text = String(value);
  if (!pattern.test(text)) throw new PublicError(400, 'API query 형식이 올바르지 않습니다.');
  return text;
}

async function readRequestBody(request, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new PublicError(413, '요청 본문이 너무 큽니다.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readFetchBody(response, maxBytes) {
  const announced = Number(response.headers.get('content-length') || 0);
  if (announced > maxBytes) throw new PublicError(502, '업스트림 응답이 허용 크기를 넘습니다.');
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  let ended = false;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        ended = true;
        break;
      }
      const chunk = Buffer.from(result.value);
      size += chunk.length;
      if (size > maxBytes) throw new PublicError(502, '업스트림 응답이 허용 크기를 넘습니다.');
      chunks.push(chunk);
    }
  } finally {
    if (!ended) await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}

function extractUpstreamError(text) {
  const cleaned = String(text || '').trim();
  if (!cleaned) return 'Invidious 업스트림 요청이 실패했습니다.';
  try {
    const parsed = JSON.parse(cleaned);
    return String(parsed.error || parsed.message || 'Invidious 업스트림 요청이 실패했습니다.').slice(0, 300);
  } catch {
    return cleaned.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 300);
  }
}

function normalizeUpstreamStatus(status) {
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502;
}

function normalizeVideoContentType(value) {
  const mime = String(value || '').split(';')[0].trim().toLowerCase();
  return /^video\/(?:mp4|webm|ogg)$/.test(mime) ? mime : 'video/mp4';
}

function setCommonHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Server', 'relay');
}

function sendJson(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  response.end(body);
}

function isAuthorized(value) {
  const supplied = Array.isArray(value) ? value[0] : String(value || '');
  const expectedHash = createHash('sha256').update(RELAY_KEY).digest();
  const suppliedHash = createHash('sha256').update(supplied).digest();
  return timingSafeEqual(expectedHash, suppliedHash);
}

function consumeRateBudget() {
  const now = Date.now();
  if (now - requestWindowStartedAt >= 60000) {
    requestWindowStartedAt = now;
    requestsInWindow = 0;
  }
  requestsInWindow += 1;
  return requestsInWindow <= REQUESTS_PER_MINUTE;
}

function integerEnv(name, fallback, min, max) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}
