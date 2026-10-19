import type { IncomingMessage } from 'node:http';

export function trustedIngress(req: IncomingMessage): boolean {
  return ['172.30.32.2', '::ffff:172.30.32.2'].includes(req.socket.remoteAddress ?? '');
}
export function ingressPath(req: IncomingMessage): string | undefined {
  const value = req.headers['x-ingress-path'];
  return typeof value === 'string' && /^\/api\/hassio_ingress\/[A-Za-z0-9_-]+$/.test(value.replace(/\/$/, ''))
    ? value.replace(/\/$/, '') : undefined;
}
export function ingressMutationAllowed(req: IncomingMessage): boolean {
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  // Reject cross-site form and fetch requests. A secret per-UI-session CSRF
  // header is independently required by server.ts for every mutation.
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const authority = req.headers['x-forwarded-host'] ?? req.headers.host;
    return new URL(origin).host === authority;
  } catch { return false; }
}
