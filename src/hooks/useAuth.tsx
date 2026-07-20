import { useEffect, useRef, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

export function useAuth() {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const userIdRef = useRef<string | null>(null);

  useEffect(() => {
    // Check existing session uma única vez no mount
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      userIdRef.current = s?.user?.id ?? null;
      setSession(s);
      setUser(s?.user ?? null);
      setLoading(false);
    });

    // Listener: só troca estado quando a identidade muda de fato.
    // TOKEN_REFRESHED / INITIAL_SESSION / USER_UPDATED mantêm o mesmo user id.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => {
      const nextUserId = s?.user?.id ?? null;
      if (nextUserId === userIdRef.current) return;
      userIdRef.current = nextUserId;
      setSession(s);
      setUser(s?.user ?? null);
    });

    return () => subscription.unsubscribe();
  }, []);

  return { session, user, loading, signOut: () => supabase.auth.signOut() };
}
