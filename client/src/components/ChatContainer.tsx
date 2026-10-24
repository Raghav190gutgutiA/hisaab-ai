import { useEffect, useRef, useState } from 'react';
import { Settings } from 'lucide-react';
import { ChatInput } from './ChatInput';
import { ChatMessage } from './ChatMessage';
import { Logo } from './Logo.tsx';
import { SettingsPanel } from './SettingsPanel.tsx';
import { streamChat } from '../lib/api.ts';
import type { ExpenseFormat, StreamEvent, StreamMessage, User } from '../type.ts';

const EXAMPLES = [
  { icon: '☕', title: 'tea 20, taxi 80', desc: 'Log several expenses at once' },
  { icon: '📒', title: "show today's expenses", desc: 'See what you spent today' },
  { icon: '🗓️', title: "show this month's expenses", desc: 'Your spending this month' },
  { icon: '🔍', title: 'analyse my spending this month', desc: 'Insights for any or all categories' },
];

const newId = () => crypto.randomUUID();

export function ChatContainer({ user, onLogout }: { user: User; onLogout: () => void }) {
  const messageEndRef = useRef<HTMLDivElement>(null);
  // Bumped when the user goes home, so events from an older run are ignored
  const viewRef = useRef(0);

  const [messages, setMessages] = useState<StreamMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({
      behavior: 'smooth',
    });
  }, [messages]);

  function appendEvent(event: StreamEvent, view = viewRef.current) {
    if (view !== viewRef.current) return;
    setMessages((prevMessages) => {
      const lastMessage = prevMessages[prevMessages.length - 1];

      // Streamed AI text: append to the message being written
      if (event.type === 'ai' && lastMessage?.type === 'ai') {
        const clonedMessages = [...prevMessages];
        clonedMessages[clonedMessages.length - 1] = {
          ...lastMessage,
          payload: { text: lastMessage.payload.text + event.payload.text },
        };
        return clonedMessages;
      }

      return [...prevMessages, { ...event, id: newId() } as StreamMessage];
    });
  }

  async function run(path: '/chat' | '/chat/resume', body: Record<string, unknown>) {
    setBusy(true);
    const view = viewRef.current;
    try {
      await streamChat(path, body, (event) => appendEvent(event, view));
    } catch (error) {
      appendEvent({
        type: 'error',
        payload: { message: error instanceof Error ? error.message : 'Something went wrong.' },
      }, view);
    } finally {
      setBusy(false);
    }
  }

  function submitQuery(userInput: string) {
    if (!userInput || busy) return;
    setMessages((prevMessages) => {
      // A new message cancels a pending format question on the server,
      // so lock any open picker in the UI too.
      const locked = prevMessages.map((m) =>
        m.type === 'interrupt' && !m.chosen ? { ...m, expired: true } : m
      );
      return [...locked, { id: newId(), type: 'user', payload: { text: userInput } }];
    });
    run('/chat', { query: userInput });
  }

  /**
   * Human-in-the-loop: the user's choice resumes the paused agent run.
   */
  function pickFormat(messageId: string, format: ExpenseFormat) {
    if (busy) return;
    setMessages((prevMessages) =>
      prevMessages.map((m) => (m.id === messageId && m.type === 'interrupt' ? { ...m, chosen: format } : m))
    );
    run('/chat/resume', { format });
  }

  /** Logo click: back to the home screen with the example prompts. */
  function goHome() {
    viewRef.current += 1;
    setMessages([]);
  }

  return (
    <div className="flex flex-col h-screen w-full bg-zinc-950">
      {/* Header */}
      <div className="shrink-0 border-b border-zinc-800 bg-zinc-900/50 backdrop-blur-xl w-full">
        <div className="w-full max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <button
            type="button"
            onClick={goHome}
            aria-label="Hisaab.ai home"
            title="Go to home"
            className="flex items-center gap-3 text-left rounded-xl -m-1 p-1 hover:bg-zinc-800/50 transition-colors">
            <Logo />
            <div>
              <h1 className="text-lg font-semibold text-zinc-100">Hisaab.ai</h1>
              <p className="text-xs text-zinc-500">Your expenses, in plain words</p>
            </div>
          </button>
          <div className="flex items-center gap-3">
            <span className="hidden sm:inline text-sm text-zinc-400">{user.name}</span>
            <button
              type="button"
              onClick={() => setShowSettings(true)}
              aria-label="Settings"
              className="p-2 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800">
              <Settings className="w-5 h-5" />
            </button>
          </div>
        </div>
      </div>

      {/* Messages Area */}
      <div className="flex-1 overflow-y-auto w-full">
        <div className="w-full max-w-5xl mx-auto">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full min-h-[60vh] px-6 py-8">
              <div className="mb-6">
                <Logo size="lg" />
              </div>
              <h2 className="text-3xl font-bold text-zinc-100 mb-3">
                Hi, {user.name.split(' ')[0]}!
              </h2>
              <p className="text-zinc-500 text-center max-w-md mb-8">
                Tell me what you spent in plain words. I'll keep track of it for you.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 w-full max-w-2xl px-4">
                {EXAMPLES.map((item) => (
                  <button
                    key={item.title}
                    type="button"
                    onClick={() => submitQuery(item.title)}
                    className="text-left p-4 rounded-xl bg-zinc-800/40 border border-zinc-700/50 hover:border-purple-500/50 transition-all cursor-pointer group">
                    <div className="text-2xl mb-2">{item.icon}</div>
                    <div className="text-sm font-medium text-zinc-200 group-hover:text-purple-400 transition-colors">
                      {item.title}
                    </div>
                    <div className="text-xs text-zinc-500 mt-1">{item.desc}</div>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="divide-y divide-zinc-800/50">
              {messages.map((message) => {
                return (
                  <div key={message.id}>
                    <ChatMessage message={message} busy={busy} onPickFormat={pickFormat} />
                  </div>
                );
              })}

              <div ref={messageEndRef} />
            </div>
          )}
        </div>
      </div>

      {/* Input Area */}
      <div className="shrink-0 w-full">
        <ChatInput onSubmit={submitQuery} disabled={busy} />
      </div>

      {showSettings && (
        <SettingsPanel user={user} onClose={() => setShowSettings(false)} onLogout={onLogout} />
      )}
    </div>
  );
}
