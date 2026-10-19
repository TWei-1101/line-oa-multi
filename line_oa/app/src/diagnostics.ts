// Diagnostic responses never include request credentials. Preserve response structure and messages.
const sensitive = /cookie|authorization|token|csrf|password|passwd|secret|session|credential|api[-_]?key|loginState|returnUri|redirectUri|qrCode|pinCode/i;

export function redactText(value: string, secrets: string[] = []): string {
  let text = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '');
  for (const secret of [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length)) {
    for (const encoded of new Set([secret, encodeURIComponent(secret)])) text = text.split(encoded).join('[已遮蔽]');
  }
  text = text.replace(/((?:set-cookie|cookie|authorization)\s*:\s*)[^\r\n]+/gi, '$1[已遮蔽]')
    .replace(/(\bapp-data\s*=\s*)(?:"[^"]*"|'[^']*')/gi, '$1"[已遮蔽]"')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [已遮蔽]')
    .replace(/(<input\b[^>]*\bvalue\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '$1"[已遮蔽]"')
    .replace(/((?:["']?)(?:[\w-]*(?:token|csrf|password|secret|session|cookie|credential|api[-_]?key)|ses|loginState|pin|pinCode)["']?\s*[:=]\s*)(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;&<>}]+)/gi, '$1[已遮蔽]')
    .replace(/([?&](?:amp;)?[\w.-]+=)[^\s&#"'<>]*/g, '$1[已遮蔽]')
    .replace(/(\/qrlogin\/(?:v1|oauth2)\/[^\s/?"'<>]+\/)[^\s/?"'<>]+/gi, '$1[已遮蔽]');
  return text;
}

export function diagnosticText(value: unknown, secrets: string[] = []): string {
  function lines(item: unknown, prefix = '', depth = 0): string[] {
    if (depth > 25) return [`${prefix}[巢狀深度超過限制]`];
    if (typeof item === 'string') {
      // Parse JSON responses before rendering, including JSON delivered with a text content type.
      try { const parsed: unknown = JSON.parse(item); if (parsed && typeof parsed === 'object') return lines(parsed, prefix, depth + 1); } catch {}
      return [`${prefix}${redactText(item, secrets)}`];
    }
    if (Array.isArray(item)) return item.length ? item.flatMap((v, i) => lines(v, `${prefix}[${i + 1}] `, depth + 1)) : [`${prefix}（空清單）`];
    if (item && typeof item === 'object') return Object.entries(item).filter(([, v]) => v !== undefined).flatMap(([key, v]) =>
      sensitive.test(key) || /^(?:ses|pin)$/i.test(key) ? [`${prefix}${key}: [已遮蔽]`] :
      v && typeof v === 'object' ? [`${prefix}${key}:`, ...lines(v, `${prefix}  `, depth + 1)] : lines(v, `${prefix}${key}: `, depth + 1));
    return [`${prefix}${String(item)}`];
  }
  return redactText(lines(value).join('\n'), secrets);
}

export function networkDetails(error: unknown): Record<string, unknown> {
  return error instanceof Error ? { name: error.name, code: (error as NodeJS.ErrnoException).code, message: error.message,
    ...(error.cause instanceof Error ? { cause: networkDetails(error.cause) } : {}) } : { message: String(error) };
}
