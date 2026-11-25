import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { User } from '@supabase/supabase-js';

const Context = createContext<{ user: User | null; ready: boolean }>({ user: null, ready: false });
export const useSharingAuth = () => useContext(Context);
export async function sharingAccessToken(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  if (!data.session) throw new Error('Sign in to share an album.');
  return data.session.access_token;
}
export function SharingAuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null), [ready, setReady] = useState(false);
  useEffect(() => {
    let active = true;
    void supabase.auth.getUser().then(({ data }) => { if (active) { setUser(data.user); setReady(true); } });
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'USER_UPDATED' || event === 'INITIAL_SESSION') {
        setUser(session?.user ?? null); setReady(true);
        if (event === 'SIGNED_IN') {
          const hash = sessionStorage.getItem('wicked_share_return');
          if (hash && /^#\/project\/[A-Za-z0-9_-]+$/.test(hash)) { sessionStorage.removeItem('wicked_share_return'); location.hash = hash; }
        }
      }
    });
    return () => { active = false; data.subscription.unsubscribe(); };
  }, []);
  return <Context.Provider value={{ user, ready }}>{children}</Context.Provider>;
}
