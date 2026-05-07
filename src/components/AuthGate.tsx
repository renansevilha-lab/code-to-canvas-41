import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Loader2, Sparkles } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!user) return <LoginScreen />;
  return <>{children}</>;
}

function LoginScreen() {
  const [tab, setTab] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) {
      toast.error("Falha no login", { description: error.message });
    } else {
      toast.success("Bem-vindo!");
    }
  };

  const handleSignup = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: window.location.origin },
    });
    setBusy(false);
    if (error) {
      toast.error("Falha no cadastro", { description: error.message });
    } else {
      toast.success("Cadastro criado", {
        description: "Verifique seu email para confirmar a conta.",
      });
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-3">
          <div className="mx-auto h-12 w-12 rounded-lg bg-gradient-to-br from-primary to-primary-glow text-primary-foreground font-bold text-lg flex items-center justify-center">
            S
          </div>
          <Badge variant="secondary" className="gap-1.5">
            <Sparkles className="h-3 w-3" />
            Shopee Analytics
          </Badge>
          <h1 className="text-2xl font-bold tracking-tight">Acesse sua conta</h1>
          <p className="text-sm text-muted-foreground">
            Faça login ou crie uma conta para acessar o dashboard.
          </p>
        </div>

        <Card className="p-6">
          <Tabs value={tab} onValueChange={(v) => setTab(v as "login" | "signup")}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="login">Entrar</TabsTrigger>
              <TabsTrigger value="signup">Criar conta</TabsTrigger>
            </TabsList>

            <TabsContent value="login">
              <form onSubmit={handleLogin} className="space-y-4 mt-4">
                <Field id="email-l" label="Email" type="email" value={email} onChange={setEmail} />
                <Field id="pass-l" label="Senha" type="password" value={password} onChange={setPassword} />
                <Button type="submit" className="w-full" disabled={busy}>
                  {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Entrar
                </Button>
              </form>
            </TabsContent>

            <TabsContent value="signup">
              <form onSubmit={handleSignup} className="space-y-4 mt-4">
                <Field id="email-s" label="Email" type="email" value={email} onChange={setEmail} />
                <Field
                  id="pass-s"
                  label="Senha"
                  type="password"
                  value={password}
                  onChange={setPassword}
                  hint="Mínimo 6 caracteres."
                />
                <Button type="submit" className="w-full" disabled={busy}>
                  {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Criar conta
                </Button>
              </form>
            </TabsContent>
          </Tabs>
        </Card>
      </div>
    </div>
  );
}

function Field({
  id, label, type, value, onChange, hint,
}: {
  id: string; label: string; type: string;
  value: string; onChange: (v: string) => void; hint?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type={type} value={value} onChange={(e) => onChange(e.target.value)} required autoComplete={type === "password" ? "current-password" : "email"} />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
