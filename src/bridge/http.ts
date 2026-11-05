/**
 * 跨域 HTTP 桥：由主进程（Node 全局 fetch）代理，绕过 WebView CORS 限制。
 * 返回对象提供调用方所需的最小 Response 语义（ok/status/text()/json()…）。
 */
export interface HttpResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  url: string;
}

let fetchSeq = 0;

function normalizeHeaders(headers?: HeadersInit): Record<string, string> | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) {
    const out: Record<string, string> = {};
    headers.forEach((v, k) => { out[k] = v; });
    return out;
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return headers as Record<string, string>;
}

function toResponse(r: HttpResult): Response {
  const obj = {
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    statusText: r.statusText,
    headers: new Headers(r.headers),
    url: r.url,
    redirected: false,
    type: 'default' as ResponseType,
    async json(): Promise<unknown> {
      return JSON.parse(r.body);
    },
    async text(): Promise<string> {
      return r.body;
    },
    async arrayBuffer(): Promise<ArrayBuffer> {
      return new TextEncoder().encode(r.body).buffer;
    },
    async blob(): Promise<Blob> {
      return new Blob([r.body]);
    },
    clone(): Response {
      return toResponse(r);
    },
  };
  return obj as unknown as Response;
}

export async function fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const id = ++fetchSeq;
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    window.dataforge.httpAbort(id);
  };
  init?.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const raw = (await window.dataforge.httpFetch({
      id,
      url,
      method: init?.method ?? 'GET',
      headers: normalizeHeaders(init?.headers),
      body: typeof init?.body === 'string' ? init.body : init?.body ? JSON.stringify(init.body) : undefined,
    })) as HttpResult;
    return toResponse(raw);
  } catch (err) {
    if (aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    throw err;
  } finally {
    init?.signal?.removeEventListener('abort', onAbort);
  }
}

export default fetch;
