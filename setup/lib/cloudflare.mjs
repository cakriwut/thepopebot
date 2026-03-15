import { spawn, execFileSync } from 'child_process';

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
 * Authenticate cloudflared with a Cloudflare account.
 * Opens a browser for the user to log in — runs with inherited stdio so prompts
 * and the browser-open URL are visible.
 * Throws on failure.
 */
export function cloudflaredLogin() {
  execFileSync('cloudflared', ['tunnel', 'login'], { stdio: 'inherit' });
}

/**
 * Create a named Cloudflare Tunnel.
 *
 * @param {string} name - Tunnel name (e.g. "thepopebot")
 * @returns {string} Tunnel UUID extracted from cloudflared output
 */
export function createNamedTunnel(name) {
  const output = execFileSync('cloudflared', ['tunnel', 'create', name], {
    encoding: 'utf-8',
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  const uuidRegex = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const match = (output || '').match(uuidRegex);
  if (!match) {
    throw new Error('Could not extract tunnel UUID from cloudflared output');
  }
  return match[0];
}

/**
 * Add a DNS CNAME record for a named tunnel.
 * The hostname's domain must be managed by Cloudflare.
 *
 * @param {string} name - Tunnel name or UUID
 * @param {string} hostname - Fully-qualified hostname, e.g. bot.example.com
 */
export function routeTunnelDns(name, hostname) {
  execFileSync('cloudflared', ['tunnel', 'route', 'dns', name, hostname], { stdio: 'inherit' });
}

/**
 * Start a named Cloudflare Tunnel pointing at a local port.
 * Resolves with { tunnelProcess } once the tunnel reports at least one active connection.
 *
 * @param {string} name - Tunnel name or UUID
 * @param {number} port - Local port to expose (default: 80)
 * @param {number} timeoutMs - Max wait time in ms (default: 30000)
 * @returns {Promise<{tunnelProcess: import('child_process').ChildProcess}>}
 */
export function startNamedTunnel(name, port = 80, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'cloudflared',
      ['tunnel', 'run', '--url', `http://localhost:${port}`, name],
      { stdio: ['ignore', 'pipe', 'pipe'], detached: true }
    );

    let output = '';
    // cloudflared prints "Registered tunnel connection" or "Connection registered" once live
    const connectedRegex = /registered.*(tunnel|connection)|connection.*registered/i;

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Timed out waiting for named tunnel to connect'));
    }, timeoutMs);

    const checkOutput = (data) => {
      output += data.toString();
      if (connectedRegex.test(output)) {
        clearTimeout(timeout);
        if (child.stdout) {
          child.stdout.off('data', checkOutput);
        }
        if (child.stderr) {
          child.stderr.off('data', checkOutput);
        }

        // Keep draining stdout/stderr so cloudflared does not block on full pipes
        if (child.stdout && typeof child.stdout.resume === 'function') {
          child.stdout.resume();
        }
        if (child.stderr && typeof child.stderr.resume === 'function') {
          child.stderr.resume();
        }

        // Detach the tunnel process and its stdio from the parent event loop
        if (typeof child.unref === 'function') {
          child.unref();
        }
        if (child.stdout && typeof child.stdout.unref === 'function') {
          child.stdout.unref();
        }
        if (child.stderr && typeof child.stderr.unref === 'function') {
          child.stderr.unref();
        }

        resolve({ tunnelProcess: child });
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
      reject(new Error(
        code !== 0 && code !== null
          ? `cloudflared exited with code ${code}`
          : 'cloudflared exited before the tunnel connected'
      ));
    });
  });
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
        // Keep draining stdout/stderr so cloudflared does not block on full buffers
        if (child.stdout) {
          child.stdout.resume();
        }
        if (child.stderr) {
          child.stderr.resume();
        }
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
