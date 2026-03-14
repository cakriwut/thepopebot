'use server';

import { auth } from '../auth/index.js';
import {
  createCodeWorkspace as dbCreateCodeWorkspace,
  getCodeWorkspaceById,
  getCodeWorkspacesByUser,
  updateCodeWorkspaceTitle,
  updateContainerName,
  toggleCodeWorkspaceStarred,
  deleteCodeWorkspace as dbDeleteCodeWorkspace,
  updateLastInjectedCommit,
} from '../db/code-workspaces.js';
import {
  getChatById,
  getChatByWorkspaceId,
  getMessagesByChatId,
} from '../db/chats.js';
import {
  addSession,
  getSession as getTermSession,
  getSessions,
  removeSession,
  getNextPort,
  clearWorkspaceSessions,
} from './terminal-sessions.js';

const RECOVERABLE_STATES = new Set(['exited', 'created', 'paused']);
const CONTEXT_CHAR_BUDGET = 12000;

/**
 * Build a chat context JSON string for passing to the interactive container.
 * Includes the first user message (sets the topic) + recent messages up to a char budget.
 * @param {string} chatId
 * @returns {string|null} JSON string or null if no messages
 */
function buildChatContext(chatId) {
  const chat = getChatById(chatId);
  if (!chat) return null;
  const allMessages = getMessagesByChatId(chatId);
  if (allMessages.length === 0) return null;

  const first = allMessages[0];
  const selected = [{ role: first.role, content: first.content }];
  let charCount = first.content.length;

  // Walk backward from end, adding messages up to budget
  for (let i = allMessages.length - 1; i > 0; i--) {
    const msg = allMessages[i];
    if (charCount + msg.content.length > CONTEXT_CHAR_BUDGET) break;
    selected.push({ role: msg.role, content: msg.content });
    charCount += msg.content.length;
  }

  // Reverse the tail messages (they were added back-to-front), keep first at index 0
  if (selected.length > 1) {
    const [firstMsg, ...rest] = selected;
    selected.length = 0;
    selected.push(firstMsg, ...rest.reverse());
  }

  return JSON.stringify({ title: chat.title || 'Untitled', messages: selected });
}

/**
 * Get the authenticated user or throw.
 */
async function requireAuth() {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error('Unauthorized');
  }
  return session.user;
}

/**
 * Get all code workspaces for the authenticated user.
 * @returns {Promise<object[]>}
 */
export async function getCodeWorkspaces() {
  const user = await requireAuth();
  return getCodeWorkspacesByUser(user.id);
}

/**
 * Create a new code workspace.
 * @param {string} containerName - Docker container DNS name
 * @param {string} [title='Code Workspace']
 * @returns {Promise<object>}
 */
export async function createCodeWorkspace(containerName, title = 'Code Workspace') {
  const user = await requireAuth();
  return dbCreateCodeWorkspace(user.id, { containerName, title });
}

/**
 * Rename a code workspace (with ownership check).
 * @param {string} id
 * @param {string} title
 * @returns {Promise<{success: boolean}>}
 */
export async function renameCodeWorkspace(id, title) {
  const user = await requireAuth();
  const workspace = getCodeWorkspaceById(id);
  if (!workspace || workspace.userId !== user.id) {
    return { success: false };
  }
  updateCodeWorkspaceTitle(id, title);
  return { success: true };
}

/**
 * Toggle a code workspace's starred status (with ownership check).
 * @param {string} id
 * @returns {Promise<{success: boolean, starred?: number}>}
 */
export async function starCodeWorkspace(id) {
  const user = await requireAuth();
  const workspace = getCodeWorkspaceById(id);
  if (!workspace || workspace.userId !== user.id) {
    return { success: false };
  }
  const starred = toggleCodeWorkspaceStarred(id);
  return { success: true, starred };
}

/**
 * Delete a code workspace (with ownership check).
 * @param {string} id
 * @returns {Promise<{success: boolean}>}
 */
export async function deleteCodeWorkspace(id) {
  const user = await requireAuth();
  const workspace = getCodeWorkspaceById(id);
  if (!workspace || workspace.userId !== user.id) {
    return { success: false };
  }
  dbDeleteCodeWorkspace(id);
  return { success: true };
}

/**
 * Ensure a code workspace's Docker container is running.
 * Recovers stopped/removed containers automatically.
 * @param {string} id - Workspace ID
 * @returns {Promise<{status: string, message?: string}>}
 */
export async function ensureCodeWorkspaceContainer(id) {
  const user = await requireAuth();
  const workspace = getCodeWorkspaceById(id);
  if (!workspace || workspace.userId !== user.id) {
    return { status: 'error', message: 'Workspace not found' };
  }

  if (!workspace.containerName) {
    return { status: 'no_container' };
  }

  try {
    const { inspectContainer, startContainer, removeContainer, runCodeWorkspaceContainer } =
      await import('../tools/docker.js');

    // Build fresh chat context for recreation
    const linkedChat = getChatByWorkspaceId(id);
    const chatContext = linkedChat ? buildChatContext(linkedChat.id) : null;

    const info = await inspectContainer(workspace.containerName);

    if (!info) {
      // Container not found — recreate
      await runCodeWorkspaceContainer({
        containerName: workspace.containerName,
        repo: workspace.repo,
        branch: workspace.branch,
        codingAgent: workspace.codingAgent,
        featureBranch: workspace.featureBranch,
        chatContext,
      });
      return { status: 'created' };
    }

    const state = info.State?.Status;

    if (state === 'running') {
      return { status: 'running' };
    }

    if (RECOVERABLE_STATES.has(state)) {
      try {
        await startContainer(workspace.containerName);
        return { status: 'started' };
      } catch {
        // Start failed — fall through to remove + recreate
      }
    }

    // Dead, bad state, or start failed — remove and recreate
    await removeContainer(workspace.containerName);
    await runCodeWorkspaceContainer({
      containerName: workspace.containerName,
      repo: workspace.repo,
      branch: workspace.branch,
      codingAgent: workspace.codingAgent,
      featureBranch: workspace.featureBranch,
      chatContext,
    });
    return { status: 'created' };
  } catch (err) {
    console.error(`[ensureCodeWorkspaceContainer] workspace=${id}`, err);
    return { status: 'error', message: err.message };
  }
}

/**
 * Start interactive mode: create a Docker container for the workspace.
 * @param {string} id - Workspace ID
 * @returns {Promise<{success: boolean, containerName?: string, message?: string}>}
 */
export async function startInteractiveMode(id) {
  const user = await requireAuth();
  const workspace = getCodeWorkspaceById(id);
  if (!workspace || workspace.userId !== user.id) {
    return { success: false, message: 'Workspace not found' };
  }

  if (workspace.containerName) {
    return { success: true, containerName: workspace.containerName, message: 'Already running' };
  }

  try {
    const { randomUUID } = await import('crypto');
    const containerName = `code-workspace-${randomUUID().slice(0, 8)}`;

    // Build chat context for the container
    const linkedChat = getChatByWorkspaceId(id);
    const chatContext = linkedChat ? buildChatContext(linkedChat.id) : null;

    const { runCodeWorkspaceContainer } = await import('../tools/docker.js');
    await runCodeWorkspaceContainer({
      containerName,
      repo: workspace.repo,
      branch: workspace.branch,
      codingAgent: workspace.codingAgent || 'claude-code',
      featureBranch: workspace.featureBranch,
      workspaceId: id,
      chatContext,
    });

    updateContainerName(id, containerName);
    return { success: true, containerName };
  } catch (err) {
    console.error(`[startInteractiveMode] workspace=${id}`, err);
    return { success: false, message: err.message };
  }
}

/**
 * Get git status from a running interactive container.
 * @param {string} id - Workspace ID
 * @returns {Promise<{uncommitted: string, commits: string, unpushed: string, hasUnsavedWork: boolean, headCommit: string}|null>}
 */
export async function getContainerGitStatus(id) {
  const user = await requireAuth();
  const workspace = getCodeWorkspaceById(id);
  if (!workspace || workspace.userId !== user.id || !workspace.containerName) {
    return null;
  }

  try {
    const { execInContainer } = await import('../tools/docker.js');

    const baseBranch = workspace.branch || 'main';
    // Use lastInteractiveCommit for context range (only new commits), fall back to baseBranch
    const contextRef = workspace.lastInteractiveCommit || baseBranch;

    const [statusOut, headOut, logOut, unpushedOut] = await Promise.all([
      execInContainer(workspace.containerName, 'cd /home/claude-code/workspace && git status --short 2>/dev/null'),
      execInContainer(workspace.containerName, 'cd /home/claude-code/workspace && git rev-parse HEAD 2>/dev/null'),
      execInContainer(workspace.containerName, `cd /home/claude-code/workspace && git log --format="- %h %s" ${contextRef}..HEAD 2>/dev/null`),
      execInContainer(workspace.containerName, `cd /home/claude-code/workspace && git log --oneline @{u}..HEAD 2>/dev/null`).catch(() => null),
    ]);

    if (statusOut === null && logOut === null) return null;

    const uncommitted = (statusOut || '').trim();
    const commits = (logOut || '').trim();
    const headCommit = (headOut || '').trim();
    const unpushed = unpushedOut !== null
      ? (unpushedOut || '').trim()
      : commits;

    return {
      uncommitted,
      commits,
      unpushed,
      hasUnsavedWork: uncommitted.length > 0 || unpushed.length > 0,
      headCommit,
    };
  } catch (err) {
    console.error(`[getContainerGitStatus] workspace=${id}`, err);
    return null;
  }
}

/**
 * Close interactive mode: fetch git status, stop+remove the container, clear containerName.
 * Volume is preserved so headless mode can reuse it if needed.
 * Injects session work context into the linked chat (self-contained — no client args needed).
 * @param {string} id - Workspace ID
 * @param {boolean} isClean - Whether the session has no uncommitted/unpushed work (from client dialog)
 * @returns {Promise<{success: boolean, message?: string}>}
 */
export async function closeInteractiveMode(id, isClean) {
  const user = await requireAuth();
  const workspace = getCodeWorkspaceById(id);
  if (!workspace || workspace.userId !== user.id) {
    return { success: false, message: 'Workspace not found' };
  }

  if (!workspace.containerName) {
    return { success: true, message: 'No container running' };
  }

  try {
    const { execInContainer, removeContainer } = await import('../tools/docker.js');

    // Only fetch git data and inject context when the session is clean
    let commits = '';
    let headCommit = '';

    if (isClean) {
      const baseBranch = workspace.branch || 'main';
      const contextRef = workspace.lastInteractiveCommit || baseBranch;

      try {
        const [headOut, logOut] = await Promise.all([
          execInContainer(workspace.containerName, 'cd /home/claude-code/workspace && git rev-parse HEAD 2>/dev/null'),
          execInContainer(workspace.containerName, `cd /home/claude-code/workspace && git log --format="- %h %s" ${contextRef}..HEAD 2>/dev/null`),
        ]);
        commits = (logOut || '').trim();
        headCommit = (headOut || '').trim();
      } catch (err) {
        console.error(`[closeInteractiveMode] git data fetch failed:`, err);
      }
    }

    // Destroy container (volume preserved for reuse)
    await removeContainer(workspace.containerName);
    clearWorkspaceSessions(id);
    updateContainerName(id, null);

    const linkedChat = getChatByWorkspaceId(id);

    // Inject session context into chat only for clean sessions with commits
    if (isClean && linkedChat && commits.length > 0) {
      try {
        const { getCodeAgent } = await import('../ai/agent.js');
        const { AIMessage } = await import('@langchain/core/messages');
        const { persistMessage } = await import('../ai/index.js');

        let message = 'Here are the latest code changes for our discussion.\n\n';
        message += `Repository: ${workspace.repo}\n`;
        message += `Branch: ${workspace.featureBranch || 'feature branch'} → ${workspace.branch || 'main'}\n`;
        message += '\nCommits:\n';
        message += commits;

        const agent = await getCodeAgent({
          repo: workspace.repo,
          branch: workspace.branch,
          workspaceId: id,
          chatId: linkedChat.id
        });

        await agent.updateState(
          { configurable: { thread_id: linkedChat.id } },
          { messages: [new AIMessage(message)] }
        );
        persistMessage(linkedChat.id, 'assistant', message);

        // Store HEAD hash so next session only injects new commits
        if (headCommit) {
          updateLastInjectedCommit(id, headCommit);
        }
      } catch (err) {
        console.error(`[closeInteractiveMode] context injection failed:`, err);
      }
    }

    return { success: true, chatId: linkedChat?.id || null };
  } catch (err) {
    console.error(`[closeInteractiveMode] workspace=${id}`, err);
    return { success: false, message: err.message };
  }
}

/**
 * Scan a container for running ttyd processes via a single pgrep exec.
 * Returns an array of { pid, port, type } for extra tabs (excludes port 7681 primary).
 * @param {string} containerName
 * @param {Function} execInContainer
 * @returns {Promise<Array<{pid: number, port: number, type: string}>>}
 */
async function scanContainerTtyd(containerName, execInContainer) {
  const raw = await execInContainer(containerName, 'pgrep -a ttyd 2>/dev/null || true');
  if (!raw || !raw.trim()) return [];

  const results = [];
  for (const line of raw.trim().split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const pid = parseInt(trimmed.split(/\s+/)[0], 10);
    if (isNaN(pid)) continue;

    const portMatch = trimmed.match(/-p\s+(\d+)/);
    if (!portMatch) continue;

    const port = parseInt(portMatch[1], 10);
    if (port === 7681) continue; // skip primary tab

    const type = trimmed.includes('claude') ? 'code' : 'shell';
    results.push({ pid, port, type });
  }

  return results;
}

/**
 * Create a new shell terminal session inside the workspace container.
 * @param {string} id - Workspace ID
 * @returns {Promise<{success: boolean, sessionId?: string, label?: string, message?: string}>}
 */
export async function createTerminalSession(id, type = 'shell') {
  const user = await requireAuth();
  const workspace = getCodeWorkspaceById(id);
  if (!workspace || workspace.userId !== user.id || !workspace.containerName) {
    return { success: false, message: 'Workspace not found' };
  }

  try {
    const { execInContainer } = await import('../tools/docker.js');

    // Scan for live ttyd processes to avoid port conflicts with orphaned sessions
    const scanned = await scanContainerTtyd(workspace.containerName, execInContainer);
    const scannedPorts = new Set(scanned.map(s => s.port));

    const port = getNextPort(id, scannedPorts);
    if (!port) {
      return { success: false, message: 'Too many terminal sessions' };
    }

    const { randomUUID } = await import('crypto');

    // Start ttyd in the background, then find its PID via pgrep
    const command = type === 'code'
      ? `nohup ttyd --writable -p ${port} bash -c 'cd /home/claude-code/workspace && exec claude --dangerously-skip-permissions' > /dev/null 2>&1 &`
      : `nohup ttyd --writable -p ${port} bash -c 'cd /home/claude-code/workspace && exec bash' > /dev/null 2>&1 &`;
    await execInContainer(
      workspace.containerName,
      command,
      10000,
    );

    // Wait for ttyd to bind
    await new Promise((r) => setTimeout(r, 800));

    const pidOut = await execInContainer(workspace.containerName, `pgrep -f "ttyd.*-p ${port}"`);
    if (!pidOut || !pidOut.trim()) {
      return { success: false, message: 'Failed to start shell' };
    }

    const pid = parseInt(pidOut.trim(), 10);
    if (isNaN(pid)) {
      return { success: false, message: 'Failed to start shell' };
    }

    const sessionId = randomUUID().slice(0, 8);
    const existing = getSessions(id);
    // Count only sessions of matching type for smart labeling
    let typeCount = 0;
    for (const s of existing.values()) {
      if ((s.type || 'shell') === type) typeCount++;
    }
    const label = type === 'code'
      ? `Code ${typeCount + 2}` // primary tab is implicitly "Code 1"
      : `Shell ${typeCount + 1}`;

    addSession(id, sessionId, { port, pid, label, type, createdAt: Date.now() });

    return { success: true, sessionId, label, type };
  } catch (err) {
    console.error(`[createTerminalSession] workspace=${id}`, err);
    return { success: false, message: err.message };
  }
}

/**
 * Close a shell terminal session.
 * @param {string} id - Workspace ID
 * @param {string} sessionId - Session ID
 * @returns {Promise<{success: boolean}>}
 */
export async function closeTerminalSession(id, sessionId) {
  const user = await requireAuth();
  const workspace = getCodeWorkspaceById(id);
  if (!workspace || workspace.userId !== user.id) {
    return { success: false };
  }

  const session = getTermSession(id, sessionId);
  if (!session) {
    return { success: false };
  }

  try {
    const { execInContainer } = await import('../tools/docker.js');
    await execInContainer(workspace.containerName, `kill ${session.pid} 2>/dev/null`);
  } catch {
    // Best effort
  }

  removeSession(id, sessionId);
  return { success: true };
}

/**
 * List terminal sessions for a workspace by scanning the container for live ttyd processes.
 * Reconciles with the in-memory registry: preserves labels for known sessions,
 * discovers orphaned sessions (e.g. after server restart), and prunes dead entries.
 * @param {string} id - Workspace ID
 * @returns {Promise<{success: boolean, sessions?: Array<{id: string, label: string, type: string}>}>}
 */
export async function listTerminalSessions(id) {
  const user = await requireAuth();
  const workspace = getCodeWorkspaceById(id);
  if (!workspace || workspace.userId !== user.id) {
    return { success: false, sessions: [] };
  }

  if (!workspace.containerName) {
    clearWorkspaceSessions(id);
    return { success: true, sessions: [] };
  }

  try {
    const { execInContainer } = await import('../tools/docker.js');
    const { randomUUID } = await import('crypto');

    // Single exec to discover all live ttyd processes
    const scanned = await scanContainerTtyd(workspace.containerName, execInContainer);

    // Build port→scanned map for quick lookup
    const scannedByPort = new Map();
    for (const s of scanned) {
      scannedByPort.set(s.port, s);
    }

    const existing = getSessions(id);
    const result = [];
    const matchedPorts = new Set();

    // Reconcile registry entries with live processes
    for (const [sessionId, session] of existing) {
      if (scannedByPort.has(session.port)) {
        const live = scannedByPort.get(session.port);
        // Update PID in case it changed, keep label
        session.pid = live.pid;
        result.push({ id: sessionId, label: session.label, type: session.type || 'shell' });
        matchedPorts.add(session.port);
      } else {
        // Process no longer running — remove stale entry
        removeSession(id, sessionId);
      }
    }

    // Discover processes not in registry (orphaned after server restart)
    const discovered = scanned
      .filter(s => !matchedPorts.has(s.port))
      .sort((a, b) => a.port - b.port); // sort by port to approximate creation order

    // Count existing sessions by type for label numbering
    const typeCounts = { code: 0, shell: 0 };
    for (const r of result) {
      typeCounts[r.type] = (typeCounts[r.type] || 0) + 1;
    }

    for (const proc of discovered) {
      const sessionId = randomUUID().slice(0, 8);
      const label = proc.type === 'code'
        ? `Code ${typeCounts.code + 2}` // primary tab is implicitly "Code 1"
        : `Shell ${typeCounts.shell + 1}`;
      typeCounts[proc.type] = (typeCounts[proc.type] || 0) + 1;

      addSession(id, sessionId, {
        port: proc.port,
        pid: proc.pid,
        label,
        type: proc.type,
        createdAt: Date.now(),
      });
      result.push({ id: sessionId, label, type: proc.type });
    }

    return { success: true, sessions: result };
  } catch {
    // Container likely gone, clear all
    clearWorkspaceSessions(id);
    return { success: true, sessions: [] };
  }
}
