export const AUTH_SESSION_COOKIE = isSecureCookie()
  ? "__Host-asael_session"
  : "asael_session";
const LEGACY_AUTH_SESSION_COOKIES = [
  "__Host-omniagent_session",
  "omniagent_session",
] as const;

export function getSessionToken(request?: Request) {
  const cookie = request?.headers.get("cookie");
  if (!cookie) {
    return undefined;
  }

  const parts = cookie.split(";").map((part) => part.trim());
  for (const name of [AUTH_SESSION_COOKIE, ...LEGACY_AUTH_SESSION_COOKIES]) {
    const token = parts
      .find((part) => part.startsWith(`${name}=`))
      ?.slice(name.length + 1);
    if (token) return token;
  }
  return undefined;
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

export function clearLegacySessionCookies() {
  return LEGACY_AUTH_SESSION_COOKIES.map((name) =>
    serializeCookie(name, "", {
      httpOnly: true,
      secure: name.startsWith("__Host-") || isSecureCookie(),
      sameSite: "Lax",
      path: "/",
      expires: new Date(0),
      maxAge: 0,
      priority: "High",
    }),
  );
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
