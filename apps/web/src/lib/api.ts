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

  // Attach token if present in localStorage (fallback for cross-domain cookies in production)
  if (typeof window !== 'undefined') {
    const storedToken = localStorage.getItem('cf_token');
    if (storedToken && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${storedToken}`);
    }
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

  // If response contains tokens, persist them for cross-domain fallback
  if (json.data && typeof json.data === 'object' && 'tokens' in (json.data as any)) {
    const tokens = (json.data as any).tokens;
    if (tokens?.access && typeof window !== 'undefined') {
      localStorage.setItem('cf_token', tokens.access);
      if (tokens.refresh) {
        localStorage.setItem('cf_refresh', tokens.refresh);
      }
    }
  }

  if (response.status === 401 && !path.startsWith('/auth/')) {
    try {
      const storedRefresh = typeof window !== 'undefined' ? localStorage.getItem('cf_refresh') : null;
      const refreshRes = await fetch(buildUrl('/auth/refresh'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: storedRefresh }),
        credentials: 'include',
      });
      if (refreshRes.ok) {
        const refreshJson = await refreshRes.json();
        const newAccess = refreshJson?.data?.tokens?.access;
        if (newAccess && typeof window !== 'undefined') {
          localStorage.setItem('cf_token', newAccess);
          headers.set('Authorization', `Bearer ${newAccess}`);
        }
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
      localStorage.removeItem('cf_token');
      localStorage.removeItem('cf_refresh');
      window.location.href = '/login';
    }
  }

  if (!response.ok || json.success === false) {
    throw new ApiError(json.error?.code ?? 'HTTP_ERROR', json.error?.message ?? 'Request failed');
  }
  return json.data as T;
}
