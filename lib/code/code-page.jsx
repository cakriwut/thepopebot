'use client';

import dynamic from 'next/dynamic';
import { AppSidebar } from '../chat/components/app-sidebar.js';
import { SidebarProvider, SidebarInset } from '../chat/components/ui/sidebar.js';
import { ChatNavProvider } from '../chat/components/chat-nav-context.js';
import { ChatHeader } from '../chat/components/chat-header.js';

const TerminalView = dynamic(() => import('./terminal-view.js'), { ssr: false });

export default function CodePage({ session, codeWorkspaceId }) {
  return (
    <ChatNavProvider value={{ activeChatId: null, navigateToChat: (id) => { window.location.href = id ? `/chat/${id}` : '/'; } }}>
      <SidebarProvider>
        <AppSidebar user={session.user} />
        <SidebarInset>
          <div className="flex h-svh flex-col overflow-hidden">
            <ChatHeader workspaceId={codeWorkspaceId} />
            <TerminalView codeWorkspaceId={codeWorkspaceId} />
          </div>
        </SidebarInset>
      </SidebarProvider>
    </ChatNavProvider>
  );
}
