export async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('The spatial service took too long to respond. Please retry.')), 30000);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store', headers: { Accept: 'application/json' } });
    if (!response.ok) {
      let message = `Request failed (${response.status})`;
      try {
        const payload = await response.json();
        if (typeof payload.detail === 'string') message = payload.detail;
        else if (payload.detail?.message) message = payload.detail.message;
      } catch { /* Keep the status message when the server returned no JSON. */ }
      throw new Error(message);
    }
    if (!response.headers.get('content-type')?.includes('json')) {
      throw new Error('The spatial data service is unavailable. Check the connection and retry.');
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

export function bytes(value: number) {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)} GB`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)} MB`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)} KB`;
  return `${value} B`;
}

export function saveFile(name: string, data: string, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
