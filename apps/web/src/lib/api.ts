const RAW_API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api/v1').trim().replace(/\/+$/, '');

function buildUrl(path: string): string {
  let cleanPath = path.startsWith('/') ? path : `/${path}`;
  if (RAW_API_URL.endsWith('/api/v1') && cleanPath.startsWith('/api/v1/')) {
    cleanPath = cleanPath.slice(7);
  }
  return `${RAW_API_URL}${cleanPath}`;
}

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  options: RequestInit & { organizationId?: string } = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('Content-Type', 'application/json');
  if (options.organizationId) {
    headers.set('x-organization-id', options.organizationId);
  }
  const response = await fetch(buildUrl(path), {
    ...options,
    headers,
    credentials: 'include',
  });
  const json = (await response.json()) as {
    success: boolean;
    data?: T;
    error?: { code: string; message: string };
  };
  if (response.status === 401 && !path.startsWith('/auth/')) {
    try {
      const refreshRes = await fetch(buildUrl('/auth/refresh'), {
        method: 'POST',
        credentials: 'include',
      });
      if (refreshRes.ok) {
        const retryResponse = await fetch(buildUrl(path), {
          ...options,
          headers,
          credentials: 'include',
        });
        const retryJson = (await retryResponse.json()) as {
          success: boolean;
          data?: T;
          error?: { code: string; message: string };
        };
        if (retryResponse.ok && retryJson.success !== false) {
          return retryJson.data as T;
        }
      }
    } catch {
      // Refresh failed
    }
    if (typeof window !== 'undefined') {
      window.location.href = '/login';
    }
  }

  if (!response.ok || json.success === false) {
    throw new ApiError(json.error?.code ?? 'HTTP_ERROR', json.error?.message ?? 'Request failed');
  }
  return json.data as T;
}
