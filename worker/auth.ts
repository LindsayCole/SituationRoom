export interface AuthUser {
  userId: string;
  email: string;
  displayName: string;
  isLocalDev: boolean;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export function getAuthenticatedUser(request: Request): AuthUser | null {
  const email = request.headers.get("oai-authenticated-user-email")?.trim();

  if (email && email.includes("@")) {
    const encodedName = request.headers.get("oai-authenticated-user-full-name");
    const encoding = request.headers.get("oai-authenticated-user-full-name-encoding");
    const displayName =
      encodedName && encoding === "percent-encoded-utf-8"
        ? safeDecode(encodedName) ?? email
        : email;

    // Sites guarantees the email header for signed-in visitors, but does not
    // guarantee an ID header. Keep the same D1 owner key if an ID appears later.
    return { userId: email.toLowerCase(), email, displayName, isLocalDev: false };
  }

  if (LOCAL_HOSTS.has(new URL(request.url).hostname)) {
    return {
      userId: "local-dead-puck-user",
      email: "dead-puck@sites.local",
      displayName: "Dead Puck Local User",
      isLocalDev: true,
    };
  }

  return null;
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
