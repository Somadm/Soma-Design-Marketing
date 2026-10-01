export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => (onUnauthorized = fn);

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: { ...(method !== "GET" ? { "x-sagal": "1" } : {}), ...(body !== undefined && !isForm ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  if (res.status === 401 && !url.startsWith("/api/auth/")) onUnauthorized();
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((json as { error?: string }).error ?? `Request failed (${res.status})`, res.status);
  return json as T;
}

export const api = {
  get: <T>(url: string) => request<T>("GET", url),
  post: <T>(url: string, body: unknown = {}) => request<T>("POST", url, body),
  put: <T>(url: string, body: unknown = {}) => request<T>("PUT", url, body),
  patch: <T>(url: string, body: unknown = {}) => request<T>("PATCH", url, body),
  del: <T>(url: string) => request<T>("DELETE", url),
  upload: <T>(url: string, file: File | Blob, filename?: string) => {
    const fd = new FormData();
    fd.append("file", file, filename ?? (file as File).name ?? "upload");
    return request<T>("POST", url, fd);
  },
};

/** POST that answers with server-sent events (Sagal's streamed reply). */
export async function stream(url: string, body: unknown, onEvent: (e: { type: string; [k: string]: unknown }) => void, signal?: AbortSignal) {
  const res = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "x-sagal": "1", "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (res.status === 401) onUnauthorized();
  if (!res.ok || !res.body) {
    const json = await res.json().catch(() => ({}));
    throw new ApiError((json as { error?: string }).error ?? `Request failed (${res.status})`, res.status);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (chunk.startsWith("data: ")) onEvent(JSON.parse(chunk.slice(6)));
    }
  }
}
