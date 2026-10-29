import { ApiError, authenticate, corsHeaders, getLimits, isRecord, MAX_BODY_BYTES, MAX_PROVIDER_BYTES, parseChat, parseRegistry, readBounded, systemPrompt } from './core';
export { ClassroomQuota } from './quota';

async function handler(request: Request, env: Env, headers: Headers, requestId: string): Promise<Response> {
  const url = new URL(request.url);
  const send = (data: unknown, status = 200) => Response.json(data, { status, headers });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (url.pathname === '/health' && request.method === 'GET') {
    let ready = false;
    try { ready = env.API_ENABLED === 'true' && !!env.DEEPSEEK_API_KEY?.trim() && parseRegistry(env.STUDENT_CODES_JSON).length > 0 && !!getLimits(env); } catch { /* Expose readiness, never secret details. */ }
    return send({ ok: true, ready, service: 'classroom-deepseek-api', version: '1.0.0' });
  }
  if (url.pathname !== '/v1/chat' && url.pathname !== '/v1/usage') throw new ApiError(404, 'not_found', 'Используй адрес /v1/chat для сообщений или /health для проверки.');
  if ((url.pathname === '/v1/chat' && request.method !== 'POST') || (url.pathname === '/v1/usage' && request.method !== 'GET')) throw new ApiError(405, 'method_not_allowed', 'Для /v1/chat нужен POST, для /v1/usage нужен GET.');
  if (env.API_ENABLED !== 'true') throw new ApiError(503, 'service_paused', 'Преподаватель временно приостановил API.');
  if (!env.DEEPSEEK_API_KEY?.trim()) throw new ApiError(503, 'not_configured', 'Преподавателю нужно добавить ключ DeepSeek на сервер.');
  const student = await authenticate(request, parseRegistry(env.STUDENT_CODES_JSON));
  const limits = getLimits(env);
  const quota = env.QUOTAS.getByName(env.CLASSROOM_ID);
  if (url.pathname === '/v1/usage') return send(await quota.usage(student));
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('Content-Type') ?? '')) throw new ApiError(415, 'json_required', 'Отправь JSON с заголовком Content-Type: application/json.');
  const declaredLength = Number(request.headers.get('Content-Length') ?? 0);
  if (declaredLength > MAX_BODY_BYTES) throw new ApiError(413, 'input_too_large', 'Сократи историю диалога.');
  let value: unknown;
  try { value = JSON.parse(await readBounded(request.body, MAX_BODY_BYTES)); }
  catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(400, 'invalid_json', 'Проверь формат JSON.'); }
  const input = parseChat(value);
  // Reserve before making a paid call; failures are intentionally not refunded.
  const reservation = await quota.reserve(student);
  if (!reservation.allowed) {
    const message = reservation.reason === 'student_minute' ? 'Слишком много запросов подряд. Подожди немного.' : 'Лимит запросов на сегодня закончился. Обратись к преподавателю.';
    throw new ApiError(429, reservation.reason ?? 'quota_exceeded', message, reservation.retryAfter);
  }
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const upstream = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.DEEPSEEK_API_KEY.trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: env.MODEL, messages: [{ role: 'system', content: systemPrompt(input) }, ...input.messages], max_tokens: limits.maxOutput, stream: false, thinking: { type: 'disabled' } }),
      signal: controller.signal,
    });
    if (!upstream.ok) {
      await upstream.body?.cancel();
      if (upstream.status === 429 || upstream.status === 503) throw new ApiError(503, 'provider_busy', 'DeepSeek сейчас занят. Попробуй позже.', 30);
      throw new ApiError(502, 'provider_error', 'DeepSeek не выполнил запрос. Преподавателю нужно проверить ключ, баланс и модель.');
    }
    let data: unknown;
    try { data = JSON.parse(await readBounded(upstream.body, MAX_PROVIDER_BYTES, 502)); }
    catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(502, 'invalid_provider_response', 'Не удалось прочитать ответ DeepSeek.'); }
    if (!isRecord(data) || !Array.isArray(data.choices) || !isRecord(data.choices[0]) || !isRecord(data.choices[0].message) || typeof data.choices[0].message.content !== 'string' || !data.choices[0].message.content.trim()) throw new ApiError(502, 'invalid_provider_response', 'DeepSeek не вернул текст ответа.');
    const first = data.choices[0];
    const usage = isRecord(data.usage) ? { inputTokens: typeof data.usage.prompt_tokens === 'number' ? data.usage.prompt_tokens : null, outputTokens: typeof data.usage.completion_tokens === 'number' ? data.usage.completion_tokens : null } : null;
    console.log(JSON.stringify({ event: 'chat_completed', requestId, project: input.project, elapsedMs: Date.now() - started, usage }));
    return send({ reply: data.choices[0].message.content, truncated: first.finish_reason === 'length', usage, remaining: reservation.remaining, requestId });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (controller.signal.aborted) throw new ApiError(504, 'provider_timeout', 'DeepSeek не успел ответить за 30 секунд. Попробуй более короткий вопрос.');
    throw new ApiError(502, 'provider_unavailable', 'Не удалось связаться с DeepSeek. Попробуй позже.');
  } finally { clearTimeout(timeout); }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = crypto.randomUUID();
    let headers = new Headers({ 'Vary': 'Origin', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    try {
      headers = corsHeaders(request, env);
      headers.set('X-Request-Id', requestId);
      return await handler(request, env, headers, requestId);
    } catch (error) {
      const known = error instanceof ApiError ? error : new ApiError(503, 'service_unavailable', 'API временно недоступен. Обратись к преподавателю.');
      headers.set('X-Request-Id', requestId);
      if (known.retryAfter) headers.set('Retry-After', String(known.retryAfter));
      console.log(JSON.stringify({ event: 'request_failed', requestId, code: known.code, status: known.status }));
      return Response.json({ error: { code: known.code, message: known.message }, requestId }, { status: known.status, headers });
    }
  },
} satisfies ExportedHandler<Env>;
