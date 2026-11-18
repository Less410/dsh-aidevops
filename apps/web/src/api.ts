const TOKEN_KEY = "ai-devops-session";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly requestId = "",
    readonly detail = "",
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export async function api<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type") && init.body) {
    headers.set("Content-Type", "application/json");
  }
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(path, { ...init, headers });
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    payload = text;
  }

  if (!response.ok) {
    const errorBody =
      payload && typeof payload === "object"
        ? (payload as {
            message?: unknown;
            requestId?: unknown;
            detail?: unknown;
          })
        : null;
    const message =
      typeof errorBody?.message === "string"
        ? errorBody.message
        : `请求失败（${response.status}）`;
    throw new ApiError(
      message,
      response.status,
      typeof errorBody?.requestId === "string" ? errorBody.requestId : "",
      typeof errorBody?.detail === "string" ? errorBody.detail : "",
    );
  }
  return payload as T;
}

