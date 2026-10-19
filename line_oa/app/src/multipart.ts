export interface ImageMultipart {
  who: string;
  image: Buffer;
  imageType: string;
  message?: string;
  requestId?: string;
}

function dispositionValue(header: string, key: string): string | undefined {
  const match = new RegExp(`(?:^|;)\\s*${key}="([^"]*)"`, 'i').exec(header);
  return match?.[1];
}

export function multipartBoundary(contentType: string): string {
  const match = /^multipart\/form-data\s*;\s*boundary=(?:"([A-Za-z0-9'()+_,.\/:=? -]{1,70})"|([A-Za-z0-9'()+_,.\/:=?-]{1,70}))\s*$/i.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary || /[\r\n]/.test(boundary)) throw new Error('INVALID_MULTIPART');
  return boundary;
}

export function parseImageMultipart(body: Buffer, contentType: string): ImageMultipart {
  const boundary = multipartBoundary(contentType);
  const delimiter = Buffer.from(`--${boundary}`);
  const nextDelimiter = Buffer.from(`\r\n--${boundary}`);
  if (!body.subarray(0, delimiter.length).equals(delimiter)) throw new Error('INVALID_MULTIPART');

  const fields = new Map<string, { value: Buffer; type?: string; filename?: string }>();
  let position = delimiter.length;
  while (position < body.length) {
    if (body.subarray(position, position + 2).toString() === '--') break;
    if (body.subarray(position, position + 2).toString() !== '\r\n') throw new Error('INVALID_MULTIPART');
    position += 2;
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), position);
    if (headerEnd < 0 || headerEnd - position > 16_384) throw new Error('INVALID_MULTIPART');
    const headerText = body.subarray(position, headerEnd).toString('latin1');
    const headers = new Map<string, string>();
    for (const line of headerText.split('\r\n')) {
      const split = line.indexOf(':');
      if (split <= 0) throw new Error('INVALID_MULTIPART');
      headers.set(line.slice(0, split).trim().toLowerCase(), line.slice(split + 1).trim());
    }
    const disposition = headers.get('content-disposition') ?? '';
    if (!/^form-data(?:;|$)/i.test(disposition)) throw new Error('INVALID_MULTIPART');
    const name = dispositionValue(disposition, 'name');
    if (!name || !['who', 'image', 'message', 'request_id'].includes(name) || fields.has(name)) throw new Error('INVALID_MULTIPART');
    const filename = dispositionValue(disposition, 'filename');
    const dataStart = headerEnd + 4;
    const dataEnd = body.indexOf(nextDelimiter, dataStart);
    if (dataEnd < 0) throw new Error('INVALID_MULTIPART');
    fields.set(name, { value: body.subarray(dataStart, dataEnd), type: headers.get('content-type'), filename });
    position = dataEnd + nextDelimiter.length;
  }

  const who = fields.get('who');
  const image = fields.get('image');
  if (!who || who.filename !== undefined || !image || image.filename === undefined) throw new Error('INVALID_MULTIPART');
  const text = (field: string, max: number): string | undefined => {
    const part = fields.get(field);
    if (!part) return undefined;
    if (part.filename !== undefined || part.value.length > max || part.value.includes(0)) throw new Error('INVALID_MULTIPART');
    const value = part.value.toString('utf8');
    if (!Buffer.from(value).equals(part.value)) throw new Error('INVALID_MULTIPART');
    return value;
  };
  return {
    who: text('who', 64) ?? '',
    image: Buffer.from(image.value),
    imageType: image.type?.toLowerCase() ?? '',
    ...(fields.has('message') ? { message: text('message', 5000) } : {}),
    ...(fields.has('request_id') ? { requestId: text('request_id', 128) } : {})
  };
}
