import { spawn } from 'child_process';

/**
 * Get cloudflared installation instructions for the current platform
 */
export function getCloudflaredInstallCmd() {
  switch (process.platform) {
    case 'win32':
      return 'winget install Cloudflare.cloudflared';
    case 'darwin':
      return 'brew install cloudflared';
    default:
      return 'See https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/';
  }
}

/**
 * Start a Cloudflare Quick Tunnel pointing at a local port.
 * No Cloudflare account required — uses trycloudflare.com.
 *
 * Resolves with { url, process } once the public URL appears in cloudflared output.
 * The caller is responsible for keeping/killing the child process.
 *
 * @param {number} port - Local port to expose (default: 80)
 * @param {number} timeoutMs - Max wait time in ms (default: 30000)
 * @returns {Promise<{url: string, process: import('child_process').ChildProcess}>}
 */
export function startQuickTunnel(port = 80, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    const urlRegex = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Timed out waiting for Cloudflare tunnel URL'));
    }, timeoutMs);

    const checkOutput = (data) => {
      output += data.toString();
      const match = output.match(urlRegex);
      if (match) {
        clearTimeout(timeout);
        child.stdout.off('data', checkOutput);
        child.stderr.off('data', checkOutput);
        resolve({ url: match[0], process: child });
      }
    };

    child.stdout.on('data', checkOutput);
    child.stderr.on('data', checkOutput);

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    child.on('exit', (code) => {
      clearTimeout(timeout);
      // If the process exits before the URL was detected, reject regardless of exit code
      reject(new Error(
        code !== 0 && code !== null
          ? `cloudflared exited with code ${code}`
          : 'cloudflared exited before a tunnel URL was detected'
      ));
    });
  });
}
