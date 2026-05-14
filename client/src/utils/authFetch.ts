export function withAuthHeaders(headers: HeadersInit = {}): HeadersInit {
  const token = localStorage.getItem("accessToken");
  const refreshToken = localStorage.getItem("refreshToken");

  if (!token && !refreshToken) {
    return headers;
  }

  return {
    ...headers,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(refreshToken ? { "X-Refresh-Token": refreshToken } : {}),
  };
}

export async function authFetch(
  input: RequestInfo | URL,
  init: RequestInit = {}
): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const isReadRequest = method === "GET" || method === "HEAD";
  const response = await fetch(input, {
    ...init,
    cache: init.cache ?? (isReadRequest ? "no-store" : undefined),
    headers: withAuthHeaders(init.headers),
  });

  const nextToken = response.headers.get("x-access-token");
  if (nextToken) {
    localStorage.setItem("accessToken", nextToken);
  }

  return response;
}
