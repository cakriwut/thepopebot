import { execSync, exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Return process.env without GITHUB_TOKEN and GH_TOKEN.
 * The gh CLI auto-uses these env vars, which can shadow interactive login
 * and cause secret/variable operations to fail with the wrong identity.
 */
export function ghEnv() {
  const env = { ...process.env };
  delete env.GITHUB_TOKEN;
  delete env.GH_TOKEN;
  return env;
}

/**
 * Check if a command exists
 */
function commandExists(cmd) {
  const checkCmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    execSync(`${checkCmd} ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get Node.js version
 */
function getNodeVersion() {
  try {
    const version = execSync('node --version', { encoding: 'utf-8' }).trim();
    return version.replace('v', '');
  } catch {
    return null;
  }
}

/**
 * Check if gh CLI is authenticated
 */
async function isGhAuthenticated() {
  try {
    await execAsync('gh auth status', { env: ghEnv() });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get git remote info (owner/repo)
 */
function getGitRemoteInfo() {
  try {
    const remote = execSync('git remote get-url origin', { encoding: 'utf-8' }).trim();
    // Handle both HTTPS and SSH formats
    // https://github.com/owner/repo.git
    // git@github.com:owner/repo.git
    const httpsMatch = remote.match(/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
    const sshMatch = remote.match(/github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
    const match = httpsMatch || sshMatch;
    if (match) {
      return { owner: match[1], repo: match[2] };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Get package manager (pnpm preferred, npm fallback)
 */
function getPackageManager() {
  if (commandExists('pnpm')) return 'pnpm';
  if (commandExists('npm')) return 'npm';
  return null;
}

/**
 * Check all prerequisites and return status
 */
export async function checkPrerequisites() {
  const results = {
    node: { installed: false, version: null, ok: false },
    packageManager: { installed: false, name: null },
    gh: { installed: false, authenticated: false },
    docker: { installed: false, running: false },
    ngrok: { installed: false },
    cloudflared: { installed: false },
    git: { installed: false, remoteInfo: null },
  };

  // Check Node.js
  const nodeVersion = getNodeVersion();
  if (nodeVersion) {
    results.node.installed = true;
    results.node.version = nodeVersion;
    const [major] = nodeVersion.split('.').map(Number);
    results.node.ok = major >= 18;
  }

  // Check package manager
  const pm = getPackageManager();
  if (pm) {
    results.packageManager.installed = true;
    results.packageManager.name = pm;
  }

  // Check gh CLI
  results.gh.installed = commandExists('gh');
  if (results.gh.installed) {
    results.gh.authenticated = await isGhAuthenticated();
  }

  // Check Docker
  results.docker.installed = commandExists('docker');
  if (results.docker.installed) {
    try {
      execSync('docker info', { stdio: 'ignore' });
      results.docker.running = true;
    } catch {
      // installed but daemon not responding
    }
  }

  // Check ngrok
  results.ngrok.installed = commandExists('ngrok');

  // Check cloudflared
  results.cloudflared.installed = commandExists('cloudflared');

  // Check git
  results.git.installed = commandExists('git');
  if (results.git.installed) {
    // Initialize git repo if needed (must happen before remote check)
    try {
      execSync('git rev-parse --git-dir', { stdio: 'ignore' });
      results.git.initialized = true;
    } catch {
      results.git.initialized = false;
    }
    results.git.remoteInfo = getGitRemoteInfo();
  }

  return results;
}

/**
 * Install a global npm package
 */
export async function installGlobalPackage(packageName) {
  const pm = getPackageManager();
  const cmd = pm === 'pnpm' ? `pnpm add -g ${packageName}` : `npm install -g ${packageName}`;
  await execAsync(cmd);
}

/**
 * Run gh auth login
 */
export async function runGhAuth() {
  // This needs to be interactive, so we use execSync
  execSync('gh auth login', { stdio: 'inherit', env: ghEnv() });
}

/**
 * Check if we can open a browser (false in SSH sessions)
 */
export function canOpenBrowser() {
  return !process.env.SSH_CLIENT && !process.env.SSH_TTY && !process.env.SSH_CONNECTION;
}

export { commandExists, getGitRemoteInfo, getPackageManager };
