/**
 * VideoRisk Authenticated API Client Helper
 */

const TOKEN_STORAGE_KEY = 'vr_session_token';

export function getSessionToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setSessionToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch (err) {
    console.error('Failed to store session token:', err);
  }
}

export function removeSessionToken(): void {
  try {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch (err) {
    console.error('Failed to remove session token:', err);
  }
}

export async function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const token = getSessionToken();
  const headers = new Headers(init?.headers || {});

  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const response = await fetch(input, {
    ...init,
    headers,
  });

  return response;
}

export class ApiResponseError extends Error {
  public readonly status: number;
  public readonly code?: string;

  constructor(message: string, status: number = 0, code?: string) {
    super(message);
    this.name = 'ApiResponseError';
    this.status = status;
    this.code = code;
  }
}

function isDevDiagnosticsEnabled(): boolean {
  try {
    const viteEnv = (import.meta as any)?.env;
    if (viteEnv && typeof viteEnv.DEV === 'boolean') {
      return viteEnv.DEV;
    }
  } catch {
    // ignore
  }
  return typeof process !== 'undefined' && process.env?.NODE_ENV === 'development';
}

export function sanitizeDiagnosticText(raw: string, maxLength: number = 160): string {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|rk|pk|whsec)_(?:live|test)_[A-Za-z0-9]+\b/g, '[REDACTED_KEY]')
    .replace(/(?:\/(?:app|home|Users|tmp|var|etc|usr)\/[^\s"'<>]+|[A-Za-z]:\\[^\s"'<>]+)/g, '[REDACTED_PATH]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function looksLikeHtml(body: string, contentType: string): boolean {
  const ct = contentType.toLowerCase();
  if (ct.includes('text/html') || ct.includes('application/xhtml+xml')) {
    return true;
  }
  const trimmed = body.trim().toLowerCase();
  return (
    trimmed.startsWith('<!doctype') ||
    trimmed.startsWith('<html') ||
    trimmed.startsWith('<head') ||
    trimmed.startsWith('<body') ||
    trimmed.startsWith('<title') ||
    (trimmed.startsWith('<') && !trimmed.startsWith('<{'))
  );
}

function buildHtmlErrorMessage(status: number, fallbackErrorMessage: string): string {
  if (status === 413) {
    return 'Upload rejected before reaching the application server (HTTP 413: request size exceeds the hosting or proxy limit). Please try a smaller or compressed file.';
  }
  if (status === 401 || status === 403) {
    return `Authentication or permission check failed (HTTP ${status}). Please sign in again and retry.`;
  }
  if (status === 404) {
    return 'The requested upload or scan endpoint could not be found (HTTP 404). Please refresh and try again.';
  }
  if (status === 502 || status === 503 || status === 504) {
    return `The server or upstream proxy timed out or was temporarily unavailable (HTTP ${status}). Please try again in a moment.`;
  }
  return status > 0
    ? `${fallbackErrorMessage} (Server returned an unexpected HTML response, HTTP ${status}).`
    : `${fallbackErrorMessage} (Server returned an unexpected HTML response).`;
}

function logDevDiagnostic(context: string, details: { status: number; contentType: string; snippet?: string }): void {
  if (!isDevDiagnosticsEnabled()) return;
  console.warn('[API Response Diagnostic]', {
    context,
    status: details.status,
    contentType: details.contentType || '(none)',
    snippet: details.snippet ? sanitizeDiagnosticText(details.snippet) : '(empty)',
  });
}

export async function parseApiResponse<T = any>(
  response: Response,
  fallbackErrorMessage: string = 'Request failed. Please try again.'
): Promise<T> {
  const status = typeof response.status === 'number' ? response.status : 0;
  const contentType = response.headers?.get?.('content-type') || '';
  const isJsonContentType = /\bapplication\/(?:[\w.+-]+\+)?json\b/i.test(contentType);

  let rawText = '';
  let fallbackParsed: any;
  let usedJsonFallback = false;

  if (typeof response.text === 'function') {
    rawText = await response.text();
  } else if (typeof response.json === 'function') {
    fallbackParsed = await response.json();
    usedJsonFallback = true;
  }

  if (usedJsonFallback) {
    if (!response.ok) {
      const msg = sanitizeDiagnosticText(
        typeof fallbackParsed?.error === 'string' && fallbackParsed.error.trim()
          ? fallbackParsed.error
          : fallbackErrorMessage,
        400
      );
      throw new ApiResponseError(msg || fallbackErrorMessage, status, fallbackParsed?.code);
    }
    return fallbackParsed as T;
  }

  const trimmed = rawText.trim();

  if (!trimmed) {
    logDevDiagnostic('empty_response', { status, contentType });
    const msg = response.ok
      ? 'Server returned an empty response. Please try again.'
      : status > 0
        ? `${fallbackErrorMessage} (HTTP ${status}, empty server response).`
        : fallbackErrorMessage;
    throw new ApiResponseError(msg, status, 'EMPTY_RESPONSE');
  }

  if (looksLikeHtml(trimmed, contentType)) {
    logDevDiagnostic('html_response', { status, contentType, snippet: trimmed });
    throw new ApiResponseError(buildHtmlErrorMessage(status, fallbackErrorMessage), status, 'HTML_RESPONSE');
  }

  const shouldAttemptJsonParse = isJsonContentType || trimmed.startsWith('{') || trimmed.startsWith('[');
  if (shouldAttemptJsonParse) {
    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      logDevDiagnostic('malformed_json', { status, contentType, snippet: trimmed });
      const msg = response.ok
        ? 'Server returned a malformed response. Please try again.'
        : status > 0
          ? `${fallbackErrorMessage} (HTTP ${status}, invalid response format).`
          : `${fallbackErrorMessage} (invalid response format).`;
      throw new ApiResponseError(msg, status, 'MALFORMED_JSON');
    }

    if (!response.ok) {
      const rawServerError =
        typeof parsed?.error === 'string' && parsed.error.trim()
          ? parsed.error
          : typeof parsed?.message === 'string' && parsed.message.trim()
            ? parsed.message
            : '';
      const safeMessage = rawServerError
        ? sanitizeDiagnosticText(rawServerError, 400) || fallbackErrorMessage
        : status > 0
          ? `${fallbackErrorMessage} (HTTP ${status}).`
          : fallbackErrorMessage;
      throw new ApiResponseError(safeMessage, status, typeof parsed?.code === 'string' ? parsed.code : undefined);
    }

    return parsed as T;
  }

  // Non-JSON, non-HTML response (e.g., plain text gateway/server error)
  logDevDiagnostic('non_json_response', { status, contentType, snippet: trimmed });
  const msg = status > 0
    ? `${fallbackErrorMessage} (HTTP ${status}, unexpected server response format).`
    : `${fallbackErrorMessage} (unexpected server response format).`;
  throw new ApiResponseError(msg, status, 'NON_JSON_RESPONSE');
}

