import { useEffect, useState } from 'react';
import { ChatContainer } from './components/ChatContainer';
import { AuthScreen } from './components/AuthScreen';
import { api, session } from './lib/api.ts';
import type { User } from './type.ts';

function App() {
  const [user, setUser] = useState<User | null>(null);
  // Only check the session when a token is stored; otherwise show login at once
  const [checking, setChecking] = useState(() => session.get() !== null);

  useEffect(() => {
    if (!session.get()) return;
    api
      .me()
      .then(({ user }) => setUser(user))
      .catch(() => setUser(null))
      .finally(() => setChecking(false));
  }, []);

  async function logout() {
    await api.logout().catch(() => {});
    setUser(null);
  }

  if (checking) {
    return <div className="h-screen w-full bg-zinc-950" />;
  }

  return user ? (
    <ChatContainer key={user.id} user={user} onLogout={logout} />
  ) : (
    <AuthScreen onAuthenticated={setUser} />
  );
}

export default App;
