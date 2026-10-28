import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { SSEParser } from './sse.mjs';

function positiveInteger(value, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('Expected a positive integer');
  return parsed;
}
export function configFromEnv(env = process.env) {
  const base = new URL(env.UPSTREAM_BASE_URL || 'http://127.0.0.1:11434/v1');
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('UPSTREAM_BASE_URL must be a plain HTTP(S) base URL');
  }
  return {
    host: env.HOST || '127.0.0.1', port: positiveInteger(env.PORT, 3000),
    upstream: base.href.replace(/\/$/, ''), model: env.MODEL || 'inference-lab:qwen05-cpu',
    maxInflight: positiveInteger(env.MAX_INFLIGHT, 3),
    timeoutMs: positiveInteger(env.REQUEST_TIMEOUT_MS, 120000), bodyLimit: 64 * 1024,
  };
}
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
function apiError(res, status, message, code) {
  json(res, status, { error: { message, type: 'gateway_error', code } });
}
function bodyJSON(req, limit, signal) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const cleanup = () => {
      req.off('data', data); req.off('end', end); req.off('error', fail);
      signal.removeEventListener('abort', cancelled);
    };
    const fail = error => { cleanup(); req.resume(); reject(error); };
    const cancelled = () => fail(new Error('Request aborted while reading body'));
    const data = chunk => {
      size += chunk.length;
      if (size > limit) return fail(Object.assign(new Error('Request body exceeds 64 KiB'), { status: 413 }));
      chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('Invalid JSON body'), { status: 400 })); }
    };
    req.on('data', data); req.on('end', end); req.on('error', fail);
    signal.addEventListener('abort', cancelled, { once: true });
    if (signal.aborted) cancelled();
  });
}
function validate(body, model) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Expected a JSON object';
  if (body.model !== model) return 'Use the configured model returned by GET /v1/models';
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.some(m =>
    !m || !['system', 'user', 'assistant'].includes(m.role) || typeof m.content !== 'string')) {
    return 'messages must contain text messages with system, user or assistant roles';
  }
  if (body.stream !== undefined && typeof body.stream !== 'boolean') return 'stream must be a boolean';
  if (body.max_tokens !== undefined && (!Number.isInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > 1024)) {
    return 'max_tokens must be between 1 and 1024';
  }
  if (body.temperature !== undefined && (!Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 2)) {
    return 'temperature must be between 0 and 2';
  }
  if (body.seed !== undefined && !Number.isSafeInteger(body.seed)) return 'seed must be an integer';
  return null;
}

export function createGateway(config = configFromEnv(), { logger = line => console.log(JSON.stringify(line)) } = {}) {
  let inflight = 0;
  const counters = { accepted: 0, completed: 0, errors: 0, cancelled: 0, rejected: 0 };
  const server = http.createServer(async (req, res) => {
    const started = performance.now();
    const requestId = randomUUID();
    res.setHeader('X-Request-ID', requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const path = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET' && path === '/healthz') return json(res, 200, { status: 'ok', inflight, ...counters });
    if (req.method === 'GET' && path === '/v1/models') return json(res, 200, {
      object: 'list', data: [{ id: config.model, object: 'model', created: 0, owned_by: 'local-lab' }],
    });
    if (req.method === 'GET' && path === '/readyz') {
      try {
        const response = await fetch(`${config.upstream}/models`, { signal: AbortSignal.timeout(3000) });
        const models = await response.json();
        const ready = response.ok && models.data?.some(m => m.id === config.model);
        return json(res, ready ? 200 : 503, { ready: Boolean(ready), model: config.model });
      } catch { return json(res, 503, { ready: false, model: config.model }); }
    }
    if (req.method !== 'POST' || path !== '/v1/chat/completions') return apiError(res, 404, 'Route not found', 'not_found');
    if (inflight >= config.maxInflight) {
      counters.rejected++;
      res.setHeader('Retry-After', '1');
      req.resume();
      return apiError(res, 429, 'Gateway is at capacity; retry later', 'capacity_exceeded');
    }
    inflight++;
    counters.accepted++;
    const abort = new AbortController();
    let timedOut = false;
    let disconnected = false;
    let ttftMs = null;
    let usage = null;
    let outcome = 'error';
    const timer = setTimeout(() => { timedOut = true; abort.abort(); }, config.timeoutMs);
    const disconnect = () => { if (!res.writableFinished) { disconnected = true; abort.abort(); } };
    res.on('close', disconnect);
    req.on('aborted', disconnect);
    try {
      if (!req.headers['content-type']?.startsWith('application/json')) {
        throw Object.assign(new Error('Content-Type must be application/json'), { status: 415 });
      }
      const body = await bodyJSON(req, config.bodyLimit, abort.signal);
      const invalid = validate(body, config.model);
      if (invalid) throw Object.assign(new Error(invalid), { status: 400 });
      if (abort.signal.aborted) throw new Error('Request ended before inference');
      const streaming = body.stream === true;
      // Explicit allowlist: no arbitrary upstream parameters or client-supplied URLs/keys.
      const payload = {
        model: config.model, messages: body.messages, stream: streaming,
        max_tokens: body.max_tokens ?? 128, temperature: body.temperature ?? 0,
        ...(body.seed !== undefined ? { seed: body.seed } : {}),
        ...(streaming ? { stream_options: { include_usage: true } } : {}),
      };
      const upstream = await fetch(`${config.upstream}/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal: abort.signal,
      });
      if (!upstream.ok) {
        await upstream.body?.cancel();
        throw Object.assign(new Error(`Inference backend returned HTTP ${upstream.status}`), { status: 502 });
      }
      if (!streaming) {
        const data = await upstream.json();
        if (data.error) throw new Error('Inference backend returned an error');
        usage = data.usage ?? null;
        json(res, 200, data);
      } else {
        if (!upstream.headers.get('content-type')?.includes('text/event-stream')) throw new Error('Expected SSE from backend');
        let done = false;
        const parser = new SSEParser(data => {
          if (data === '[DONE]') { done = true; return; }
          const event = JSON.parse(data);
          if (event.error) throw new Error('Inference backend returned a streaming error');
          if (event.choices?.some(choice => typeof choice.delta?.content === 'string' && choice.delta.content.length)) {
            ttftMs ??= performance.now() - started;
          }
          if (event.usage) usage = event.usage;
        });
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no',
        });
        res.flushHeaders();
        for await (const chunk of upstream.body) {
          parser.push(chunk);
          if (!res.write(chunk)) await once(res, 'drain', { signal: abort.signal });
        }
        parser.finish();
        if (!done) throw new Error('Backend stream ended without [DONE]');
        res.end();
      }
      outcome = 'completed';
      counters.completed++;
    } catch (error) {
      if (disconnected) { outcome = 'cancelled'; counters.cancelled++; }
      else {
        counters.errors++;
        outcome = timedOut ? 'timeout' : 'error';
        const status = timedOut ? 504 : error.status || 502;
        const message = timedOut ? 'Inference deadline exceeded' : error.message;
        if (!res.headersSent && !res.destroyed) apiError(res, status, message, outcome);
        else if (!res.destroyed) res.end(`data: ${JSON.stringify({ error: { message, code: outcome } })}\n\n`);
      }
    } finally {
      clearTimeout(timer);
      res.off('close', disconnect);
      req.off('aborted', disconnect);
      abort.abort();
      inflight--;
      // Prompt/response text is deliberately excluded from operational logs.
      logger({ event: 'request', request_id: requestId, outcome, model: config.model,
        ttft_ms: ttftMs, latency_ms: performance.now() - started, usage, inflight });
    }
  });
  server.headersTimeout = 10000;
  server.requestTimeout = config.timeoutMs;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = configFromEnv();
  const server = createGateway(config);
  server.listen(config.port, config.host, () => console.log(JSON.stringify({
    event: 'listening', host: config.host, port: config.port, model: config.model,
    max_inflight: config.maxInflight, timeout_ms: config.timeoutMs,
  })));
  const stop = () => { server.close(); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
