export const AUTH_SESSION_COOKIE = isSecureCookie()
  ? "__Host-asael_session"
  : "asael_session";

export function getSessionToken(request?: Request) {
  const cookie = request?.headers.get("cookie");
  if (!cookie) {
    return undefined;
  }

  return cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${AUTH_SESSION_COOKIE}=`))
    ?.slice(AUTH_SESSION_COOKIE.length + 1);
}

export function sessionCookie(token: string, expiresAt: string) {
  return serializeCookie(AUTH_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isSecureCookie(),
    sameSite: "Lax",
    path: "/",
    expires: new Date(expiresAt),
    priority: "High",
  });
}

export function clearSessionCookie() {
  return serializeCookie(AUTH_SESSION_COOKIE, "", {
    httpOnly: true,
    secure: isSecureCookie(),
    sameSite: "Lax",
    path: "/",
    expires: new Date(0),
    maxAge: 0,
    priority: "High",
  });
}

function serializeCookie(
  name: string,
  value: string,
  options: {
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "Lax" | "Strict" | "None";
    path?: string;
    expires?: Date;
    maxAge?: number;
    priority?: "Low" | "Medium" | "High";
  },
) {
  const parts = [`${name}=${encodeURIComponent(value)}`];

  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${options.maxAge}`);
  }

  if (options.expires) {
    parts.push(`Expires=${options.expires.toUTCString()}`);
  }

  if (options.path) {
    parts.push(`Path=${options.path}`);
  }

  if (options.httpOnly) {
    parts.push("HttpOnly");
  }

  if (options.secure) {
    parts.push("Secure");
  }

  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  }

  if (options.priority) {
    parts.push(`Priority=${options.priority}`);
  }

  return parts.join("; ");
}

function isSecureCookie() {
  return process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);
}
