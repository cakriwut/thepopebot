import http from 'http';

/**
 * Make a request to the Docker Engine API via Unix socket.
 * @param {string} method - HTTP method
 * @param {string} path - API path
 * @param {object} [body] - Request body
 * @returns {Promise<object>} Parsed JSON response
 */
function dockerApi(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      socketPath: '/var/run/docker.sock',
      path,
      method,
      headers: { 'Content-Type': 'application/json' },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: data ? JSON.parse(data) : {} });
        } catch {
          resolve({ status: res.statusCode, data: { message: data } });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * Auto-detect the Docker network by inspecting the event-handler container.
 * @returns {Promise<string>} Network name
 */
async function detectNetwork() {
  try {
    const { status, data } = await dockerApi('GET', '/containers/thepopebot-event-handler/json');
    if (status === 200 && data.NetworkSettings?.Networks) {
      const networks = Object.keys(data.NetworkSettings.Networks);
      if (networks.length > 0) return networks[0];
    }
  } catch {}
  return 'bridge';
}

/**
 * Create and start a code workspace Docker container.
 * @param {object} options
 * @param {string} options.containerName - Docker container name
 * @param {string} options.repo - GitHub repo full name (e.g. "owner/repo")
 * @param {string} options.branch - Git branch name
 * @param {string} [options.codingAgent='claude-code'] - Coding agent identifier
 * @returns {Promise<{containerId: string}>}
 */
async function createCodeWorkspaceContainer({ containerName, repo, branch, codingAgent = 'claude-code' }) {
  if (codingAgent !== 'claude-code') {
    throw new Error(`Unsupported coding agent: ${codingAgent}`);
  }

  const version = process.env.THEPOPEBOT_VERSION || 'latest';
  const image = `stephengpope/thepopebot:claude-code-workspace-${version}`;
  const network = await detectNetwork();

  const env = [
    `REPO=${repo}`,
    `BRANCH=${branch}`,
  ];
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    env.push(`CLAUDE_CODE_OAUTH_TOKEN=${process.env.CLAUDE_CODE_OAUTH_TOKEN}`);
  }
  if (process.env.GH_TOKEN) {
    env.push(`GH_TOKEN=${process.env.GH_TOKEN}`);
  }

  // Pull image only if not already present locally
  const inspectRes = await dockerApi('GET', `/images/${encodeURIComponent(image)}/json`);
  if (inspectRes.status !== 200) {
    const pullRes = await dockerApi('POST', `/images/create?fromImage=${encodeURIComponent('stephengpope/thepopebot')}&tag=${encodeURIComponent(`claude-code-workspace-${version}`)}`);
    if (pullRes.status !== 200) {
      throw new Error(`Docker pull failed (${pullRes.status}): ${pullRes.data?.message || JSON.stringify(pullRes.data)}`);
    }
  }

  // Create container
  const createRes = await dockerApi('POST', `/containers/create?name=${encodeURIComponent(containerName)}`, {
    Image: image,
    Env: env,
    HostConfig: {
      NetworkMode: network,
    },
  });

  if (createRes.status !== 201) {
    throw new Error(`Docker create failed (${createRes.status}): ${createRes.data?.message || JSON.stringify(createRes.data)}`);
  }

  const containerId = createRes.data.Id;

  // Start container
  const startRes = await dockerApi('POST', `/containers/${containerId}/start`);
  if (startRes.status !== 204 && startRes.status !== 304) {
    throw new Error(`Docker start failed (${startRes.status}): ${startRes.data?.message || JSON.stringify(startRes.data)}`);
  }

  return { containerId };
}

/**
 * Inspect a Docker container by name.
 * @param {string} containerName
 * @returns {Promise<object|null>} Container info or null if not found
 */
async function inspectContainer(containerName) {
  const { status, data } = await dockerApi('GET', `/containers/${encodeURIComponent(containerName)}/json`);
  if (status === 404) return null;
  if (status === 200) return data;
  throw new Error(`Docker inspect failed (${status}): ${data?.message || JSON.stringify(data)}`);
}

/**
 * Start a stopped Docker container.
 * @param {string} containerName
 */
async function startContainer(containerName) {
  const { status, data } = await dockerApi('POST', `/containers/${encodeURIComponent(containerName)}/start`);
  if (status === 204 || status === 304) return;
  throw new Error(`Docker start failed (${status}): ${data?.message || JSON.stringify(data)}`);
}

/**
 * Force-remove a Docker container.
 * @param {string} containerName
 */
async function removeContainer(containerName) {
  const { status, data } = await dockerApi('DELETE', `/containers/${encodeURIComponent(containerName)}?force=true`);
  if (status === 204 || status === 404) return;
  throw new Error(`Docker remove failed (${status}): ${data?.message || JSON.stringify(data)}`);
}

export { createCodeWorkspaceContainer, inspectContainer, startContainer, removeContainer };
