/**
 * Loopback addresses that are safe to bind to without authentication —
 * anything reachable only from this machine.
 *
 * Anything else (`0.0.0.0`, a LAN IP, a public hostname) is treated as
 * "exposed to the network" and rejected at startup. emploke does not
 * ship its own auth layer; for remote access, terminate elsewhere
 * (SSH port-forward, reverse proxy with mTLS / OIDC, Tailscale, …)
 * and keep the server bound to loopback.
 */
export function isLoopbackBind(host: string): boolean {
  if (host === "127.0.0.1" || host === "localhost") return true;
  if (host === "::1" || host === "[::1]") return true;
  // IPv4-mapped IPv6 loopback (`::ffff:127.0.0.1`, optionally bracketed)
  // — Node's dual-stack sockets normalise this to v4 loopback at bind
  // time, so it's just as safe as the literal v4 form. Cheaper to
  // recognise here than to leave a paper-cut for users who explicitly
  // type the v6 form.
  if (host.startsWith("::ffff:127.") || host.startsWith("[::ffff:127.")) return true;
  // Other 127.x.x.x addresses are also loopback per RFC 5735, but we
  // expect production users to spell them as 127.0.0.1.
  return host.startsWith("127.");
}

/**
 * Refuse to start when the configured bind would be reachable from the
 * network. The check runs before any port binding so a misconfigured
 * deployment fails closed at startup rather than silently exposing
 * destructive endpoints (DELETE /api/skills/:name etc.).
 *
 * Auth was removed deliberately (issue #98 follow-up): the previous
 * built-in `EMPLOKE_API_KEY` Bearer scheme was a half-finished
 * shared-secret with a real SSE auth gap (browser `EventSource` cannot
 * send custom headers), and "rolling our own auth" is rarely the right
 * answer for a single-user local-first dashboard. Operators who need
 * remote access should terminate auth at a layer designed for it.
 */
export function assertBindIsSafe(host: string): void {
  if (isLoopbackBind(host)) return;
  throw new Error(
    `Refusing to bind to ${host}. emploke binds to loopback only.\n` +
      `For remote access, expose the loopback socket through a layer designed for auth:\n` +
      `  - SSH port-forward: ssh -L 8787:127.0.0.1:8787 user@host\n` +
      `  - Reverse proxy with mTLS / OIDC (nginx, Caddy, Traefik, …) in front of 127.0.0.1:8787\n` +
      `  - Mesh VPN with peer auth (Tailscale, Nebula, WireGuard, …)\n` +
      `Set EMPLOKE_HOST=127.0.0.1 (the default) to silence this error.`,
  );
}
