// Desktop web protocol identity shared by QR login and authenticated requests.
// These are Chromium's reduced platform tokens, including macOS on Apple Silicon.
// No browser process is started; the add-on itself still runs on Linux/Node.js.
export function lineUserAgent(architecture: NodeJS.Architecture = process.arch): string {
  const platform = architecture === 'x64' || architecture === 'ia32'
    ? 'Windows NT 10.0; Win64; x64'
    : architecture === 'arm64' || architecture === 'arm'
      ? 'Macintosh; Intel Mac OS X 10_15_7'
      : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36`;
}

export const LINE_USER_AGENT = lineUserAgent();
