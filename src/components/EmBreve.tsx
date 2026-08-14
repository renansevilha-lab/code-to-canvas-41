import { Construction } from "lucide-react";
import { Link } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

interface Props {
  title: string;
  description: string;
}

export function EmBreve({ title, description }: Props) {
  return (
    <div className="p-6 md:p-10">
      <Card className="max-w-2xl mx-auto p-10 text-center">
        <div className="mx-auto h-14 w-14 rounded-full bg-warning/15 text-warning-foreground flex items-center justify-center mb-5">
          <Construction className="h-7 w-7" />
        </div>
        <h1 className="text-2xl font-semibold text-foreground mb-2">{title}</h1>
        <p className="text-muted-foreground mb-6 max-w-md mx-auto">
          {description}
        </p>
        <p className="text-sm text-muted-foreground mb-6">
          Por enquanto, comece pelo módulo de Vendas — ele é o coração do sistema.
        </p>
        <Button asChild>
          <Link to="/vendas" search={{ period: "today", view: "sku", sort: "receita" }}>Ir para Vendas</Link>
        </Button>
      </Card>
    </div>
  );
}
