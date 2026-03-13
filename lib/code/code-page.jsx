'use client';

import { useState, useCallback, useEffect } from 'react';
import dynamic from 'next/dynamic';
import { DndContext, closestCenter, PointerSensor, KeyboardSensor, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, horizontalListSortingStrategy, useSortable, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { AppSidebar } from '../chat/components/app-sidebar.js';
import { SidebarProvider, SidebarInset } from '../chat/components/ui/sidebar.js';
import { ChatNavProvider } from '../chat/components/chat-nav-context.js';
import { ChatHeader } from '../chat/components/chat-header.js';
import { ConfirmDialog } from '../chat/components/ui/confirm-dialog.js';
import { CodeIcon, TerminalIcon, SpinnerIcon } from '../chat/components/icons.js';
import { cn } from '../chat/utils.js';
import {
  ensureCodeWorkspaceContainer,
  closeInteractiveMode,
  getContainerGitStatus,
  createTerminalSession,
  closeTerminalSession,
  listTerminalSessions,
} from './actions.js';

const TerminalView = dynamic(() => import('./terminal-view.js'), { ssr: false });

function getStorageKey(id) {
  return `code-tab-order-${id}`;
}

function saveTabOrder(id, tabs) {
  try {
    const ids = tabs.filter((t) => t.id !== PRIMARY_TAB_ID).map((t) => t.id);
    if (ids.length > 0) {
      localStorage.setItem(getStorageKey(id), JSON.stringify(ids));
    } else {
      localStorage.removeItem(getStorageKey(id));
    }
  } catch {}
}

function loadTabOrder(id) {
  try {
    const raw = localStorage.getItem(getStorageKey(id));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function reorderByStored(tabs, storedOrder) {
  if (!storedOrder || storedOrder.length === 0) return tabs;
  const primary = tabs[0]; // claude-code always first
  const dynamic = tabs.slice(1);
  const orderMap = new Map(storedOrder.map((id, i) => [id, i]));
  dynamic.sort((a, b) => {
    const ai = orderMap.has(a.id) ? orderMap.get(a.id) : Infinity;
    const bi = orderMap.has(b.id) ? orderMap.get(b.id) : Infinity;
    return ai - bi;
  });
  return [primary, ...dynamic];
}

const PRIMARY_TAB_ID = 'code-primary';

export default function CodePage({ session, codeWorkspaceId }) {
  const [dialogState, setDialogState] = useState('closed'); // 'closed' | 'loading' | 'safe' | 'warning' | 'error'
  const [gitStatus, setGitStatus] = useState(null);
  const [closing, setClosing] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const [tabs, setTabs] = useState([
    { id: PRIMARY_TAB_ID, label: 'Code', type: 'code', primary: true },
  ]);
  const [activeTabId, setActiveTabId] = useState(PRIMARY_TAB_ID);
  const [creatingShell, setCreatingShell] = useState(false);
  const [creatingCode, setCreatingCode] = useState(false);
  const [closingTabId, setClosingTabId] = useState(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor)
  );

  // Restore existing sessions on mount
  useEffect(() => {
    listTerminalSessions(codeWorkspaceId).then((result) => {
      if (result?.success && result.sessions?.length > 0) {
        const restored = [
          { id: PRIMARY_TAB_ID, label: 'Code', type: 'code', primary: true },
          ...result.sessions.map((s) => ({ id: s.id, label: s.label, type: s.type || 'shell' })),
        ];
        const storedOrder = loadTabOrder(codeWorkspaceId);
        setTabs(reorderByStored(restored, storedOrder));
      }
    });
  }, [codeWorkspaceId]);

  // Persist tab order when tabs change
  useEffect(() => {
    if (tabs.length > 1) {
      saveTabOrder(codeWorkspaceId, tabs);
    }
  }, [tabs, codeWorkspaceId]);

  const handleNewCode = useCallback(async () => {
    setCreatingCode(true);
    try {
      const result = await createTerminalSession(codeWorkspaceId, 'code');
      if (result?.success) {
        const newTab = { id: result.sessionId, label: result.label, type: 'code' };
        setTabs((prev) => [...prev, newTab]);
        setActiveTabId(result.sessionId);
      }
    } catch (err) {
      console.error('[CodePage] Failed to create code tab:', err);
    } finally {
      setCreatingCode(false);
    }
  }, [codeWorkspaceId]);

  const handleNewShell = useCallback(async () => {
    setCreatingShell(true);
    try {
      const result = await createTerminalSession(codeWorkspaceId, 'shell');
      if (result?.success) {
        const newTab = { id: result.sessionId, label: result.label, type: 'shell' };
        setTabs((prev) => [...prev, newTab]);
        setActiveTabId(result.sessionId);
      }
    } catch (err) {
      console.error('[CodePage] Failed to create shell:', err);
    } finally {
      setCreatingShell(false);
    }
  }, [codeWorkspaceId]);

  const handleCloseTab = useCallback(async (tabId) => {
    try {
      await closeTerminalSession(codeWorkspaceId, tabId);
    } catch {
      // Best effort
    }
    setTabs((prev) => prev.filter((t) => t.id !== tabId));
    setActiveTabId((prev) => (prev === tabId ? PRIMARY_TAB_ID : prev));
  }, [codeWorkspaceId]);

  const handleOpenCloseDialog = useCallback(async () => {
    setDialogState('loading');
    setGitStatus(null);
    setErrorMessage('');
    try {
      const status = await getContainerGitStatus(codeWorkspaceId);
      setGitStatus(status);
      if (status?.hasUnsavedWork) {
        setDialogState('warning');
      } else {
        setDialogState('safe');
      }
    } catch (err) {
      console.error('[CodePage] Failed to check git status:', err);
      setDialogState('safe'); // fallback to simple confirm
    }
  }, [codeWorkspaceId]);

  const handleConfirmClose = useCallback(async () => {
    setClosing(true);
    setErrorMessage('');
    try {
      const result = await closeInteractiveMode(codeWorkspaceId, dialogState === 'safe');
      if (result?.success) {
        window.location.href = result.chatId ? `/chat/${result.chatId}` : '/';
      } else {
        const msg = result?.message || 'Failed to close session';
        console.error('[CodePage] closeInteractiveMode failed:', msg);
        setErrorMessage(msg);
        setDialogState('error');
        setClosing(false);
      }
    } catch (err) {
      console.error('[CodePage] closeInteractiveMode error:', err);
      setErrorMessage(err.message || 'An unexpected error occurred');
      setDialogState('error');
      setClosing(false);
    }
  }, [codeWorkspaceId, dialogState]);

  const handleCancel = useCallback(() => {
    setDialogState('closed');
    setGitStatus(null);
  }, []);

  const handleDragEnd = useCallback((event) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setTabs((prev) => {
      const dynamicTabs = prev.slice(1);
      const oldIndex = dynamicTabs.findIndex((t) => t.id === active.id);
      const newIndex = dynamicTabs.findIndex((t) => t.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return prev;
      const reordered = arrayMove(dynamicTabs, oldIndex, newIndex);
      return [prev[0], ...reordered];
    });
  }, []);

  const isOpen = dialogState !== 'closed';

  // Build dialog props based on state
  let dialogTitle = 'Close this session?';
  let dialogDescription = '';
  let confirmLabel = 'Close Session';
  let variant = 'default';

  if (dialogState === 'loading') {
    dialogTitle = 'Checking session...';
    dialogDescription = '';
  } else if (dialogState === 'warning') {
    dialogTitle = 'Warning';
    variant = 'destructive';
    dialogDescription = 'Your session contains unsaved changes. To keep them, commit and push your changes before closing. If you close now, those changes will be lost.';
  }

  // Look up closing tab type for the confirm dialog description
  const closingTab = closingTabId ? tabs.find((t) => t.id === closingTabId) : null;
  const closingTabDescription = closingTab?.type === 'code'
    ? 'This will end the code session.'
    : 'This will end the shell session.';

  const dynamicTabIds = tabs.slice(1).map((t) => t.id);

  return (
    <ChatNavProvider value={{ activeChatId: null, navigateToChat: (id) => { window.location.href = id ? `/chat/${id}` : '/'; } }}>
      <SidebarProvider>
        <AppSidebar user={session.user} />
        <SidebarInset>
          <div className="flex h-svh flex-col overflow-hidden">
            <ChatHeader workspaceId={codeWorkspaceId} />

            {/* Tab bar */}
            <div className="flex items-end gap-0 px-4 bg-muted/30 border-b border-border shrink-0 overflow-hidden">
              {/* Primary Code tab — pinned, not draggable */}
              <PinnedTab
                tab={tabs[0]}
                isActive={activeTabId === PRIMARY_TAB_ID}
                onClick={() => setActiveTabId(PRIMARY_TAB_ID)}
                onClose={() => handleOpenCloseDialog()}
                closeTitle="Close session"
              />

              {/* Dynamic tabs — draggable */}
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                <SortableContext items={dynamicTabIds} strategy={horizontalListSortingStrategy}>
                  {tabs.slice(1).map((tab) => (
                    <SortableTab
                      key={tab.id}
                      tab={tab}
                      isActive={activeTabId === tab.id}
                      onClick={() => setActiveTabId(tab.id)}
                      onClose={() => setClosingTabId(tab.id)}
                    />
                  ))}
                </SortableContext>
              </DndContext>

              {/* Loading placeholder tabs */}
              {creatingCode && (
                <div className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium font-mono text-muted-foreground">
                  <SpinnerIcon size={12} />
                  <span>Code...</span>
                </div>
              )}
              {creatingShell && (
                <div className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium font-mono text-muted-foreground">
                  <SpinnerIcon size={12} />
                  <span>Shell...</span>
                </div>
              )}

              {/* + buttons */}
              <button
                className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium font-mono text-muted-foreground hover:text-foreground rounded-t-md border-t border-x border-dashed border-t-muted-foreground/30 border-x-muted-foreground/20 hover:border-t-muted-foreground/50 hover:border-x-muted-foreground/40 transition-all disabled:opacity-50 disabled:cursor-default"
                onClick={handleNewCode}
                disabled={creatingCode}
                title="New code tab"
              >
                + Code
              </button>
              <button
                className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium font-mono text-muted-foreground hover:text-foreground rounded-t-md border-t border-x border-dashed border-t-muted-foreground/30 border-x-muted-foreground/20 hover:border-t-muted-foreground/50 hover:border-x-muted-foreground/40 transition-all disabled:opacity-50 disabled:cursor-default"
                onClick={handleNewShell}
                disabled={creatingShell}
                title="New shell terminal"
              >
                + Shell
              </button>
            </div>

            {/* Terminal panels — all mounted, hidden via display */}
            {tabs.map((tab) => (
              <div
                key={tab.id}
                style={{
                  display: activeTabId === tab.id ? 'flex' : 'none',
                  flex: 1,
                  flexDirection: 'column',
                  minHeight: 0,
                }}
              >
                <TerminalView
                  codeWorkspaceId={codeWorkspaceId}
                  wsPath={tab.primary
                    ? `/code/${codeWorkspaceId}/ws`
                    : `/code/${codeWorkspaceId}/term/${tab.id}/ws`}
                  isActive={activeTabId === tab.id}
                  showToolbar={tab.primary === true}
                  ensureContainer={tab.primary ? ensureCodeWorkspaceContainer : undefined}
                  onCloseSession={tab.primary ? handleOpenCloseDialog : undefined}
                />
              </div>
            ))}
          </div>
          {dialogState === 'loading' && isOpen && (
            <div className="fixed inset-0 z-50 flex items-center justify-center">
              <div className="fixed inset-0 bg-black/50" />
              <div className="relative z-50 w-full max-w-sm rounded-lg border border-border bg-background p-6 shadow-lg flex flex-col items-center gap-3">
                <svg className="animate-spin h-5 w-5 text-muted-foreground" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <span className="text-sm text-muted-foreground">Checking session...</span>
              </div>
            </div>
          )}
          {(dialogState === 'safe' || dialogState === 'warning') && (
            <ConfirmDialog
              open
              title={dialogState === 'warning' ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: '#ef4444' }}>
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M8.57 3.22L1.51 15.01c-.63 1.09.16 2.49 1.43 2.49h14.12c1.27 0 2.06-1.4 1.43-2.49L11.43 3.22c-.63-1.09-2.23-1.09-2.86 0z" fill="#ef4444" />
                    <path d="M10 8v3" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
                    <circle cx="10" cy="13.5" r="0.75" fill="white" />
                  </svg>
                  Warning
                </span>
              ) : dialogTitle}
              description={dialogDescription}
              confirmLabel={closing ? 'Closing...' : confirmLabel}
              variant={variant}
              onConfirm={handleConfirmClose}
              onCancel={handleCancel}
            />
          )}
          {dialogState === 'error' && (
            <ConfirmDialog
              open
              title="Failed to close session"
              description={errorMessage}
              confirmLabel="Retry"
              variant="destructive"
              onConfirm={handleConfirmClose}
              onCancel={handleCancel}
            />
          )}
          {closingTabId && (
            <ConfirmDialog
              open
              title="Close terminal?"
              description={closingTabDescription}
              confirmLabel="Close"
              variant="default"
              onConfirm={() => {
                handleCloseTab(closingTabId);
                setClosingTabId(null);
              }}
              onCancel={() => setClosingTabId(null)}
            />
          )}
        </SidebarInset>
      </SidebarProvider>
    </ChatNavProvider>
  );
}

function PinnedTab({ tab, isActive, onClick, onClose, closeTitle }) {
  return (
    <div
      className={cn(
        'group flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium font-mono rounded-t-md border border-b-0 transition-colors cursor-pointer',
        isActive
          ? 'bg-background text-foreground border-border -mb-px'
          : 'bg-transparent text-muted-foreground border-transparent hover:text-foreground hover:bg-muted/50'
      )}
      onClick={onClick}
    >
      {tab.type === 'code' ? <CodeIcon size={12} /> : <TerminalIcon size={12} />}
      <span>{tab.label}</span>
      <button
        className="ml-1 rounded-sm p-0.5 hover:bg-destructive/20 hover:text-destructive transition-all"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        title={closeTitle || 'Close'}
      >
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <line x1="4" y1="4" x2="12" y2="12" />
          <line x1="12" y1="4" x2="4" y2="12" />
        </svg>
      </button>
    </div>
  );
}

function SortableTab({ tab, isActive, onClick, onClose }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tab.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={cn(
        'group flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium font-mono rounded-t-md border border-b-0 transition-colors cursor-grab active:cursor-grabbing',
        isActive
          ? 'bg-background text-foreground border-border -mb-px'
          : 'bg-transparent text-muted-foreground border-transparent hover:text-foreground hover:bg-muted/50'
      )}
      onClick={onClick}
    >
      {tab.type === 'code' ? <CodeIcon size={12} /> : <TerminalIcon size={12} />}
      <span>{tab.label}</span>
      <button
        className="ml-1 rounded-sm p-0.5 hover:bg-destructive/20 hover:text-destructive transition-all"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        title={tab.type === 'code' ? 'Close code tab' : 'Close shell'}
      >
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <line x1="4" y1="4" x2="12" y2="12" />
          <line x1="12" y1="4" x2="4" y2="12" />
        </svg>
      </button>
    </div>
  );
}
