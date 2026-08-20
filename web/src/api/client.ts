// Typed API client. The instance base URL is configuration (design §15) —
// same-origin (dev proxy / runad-served static build) unless VITE_API_BASE
// points elsewhere. The client must work against any instance.
export const API_BASE: string = import.meta.env.VITE_API_BASE ?? "";

export interface InstanceMeta {
  name: string;
  software_version: string;
  protocol_version: string;
  constants: Record<string, number>;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`${API_BASE}/api/v1${path}`, init);
  if (!resp.ok) {
    let code = "unknown";
    let message = resp.statusText;
    try {
      const body = await resp.json();
      code = body?.error?.code ?? code;
      message = body?.error?.message ?? message;
    } catch {
      // non-JSON error body; keep defaults
    }
    throw new ApiError(resp.status, code, message);
  }
  return resp.json() as Promise<T>;
}

export function fetchMeta(): Promise<InstanceMeta> {
  return request<InstanceMeta>("/meta");
}
