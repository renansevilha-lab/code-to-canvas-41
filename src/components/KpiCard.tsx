import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";

import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";

export interface KpiCardProps {
  label: string;
  value: string;
  hint?: string;
  delta?: { label: string; direction: "up" | "down" | "flat" };
  /**
   * Quando `betterDirection = "up"`, deltas positivos ficam verdes e negativos vermelhos.
   * Quando `"down"`, é o inverso (útil pra cancelamentos, taxas, etc.).
   */
  betterDirection?: "up" | "down";
  icon?: React.ReactNode;
  accent?: "primary" | "success" | "warning" | "destructive" | "muted";
}

const accentClasses: Record<NonNullable<KpiCardProps["accent"]>, string> = {
  primary: "bg-primary/10 text-primary",
  success: "bg-success/10 text-success",
  warning: "bg-warning/15 text-warning-foreground",
  destructive: "bg-destructive/10 text-destructive",
  muted: "bg-muted text-muted-foreground",
};

export function KpiCard({
  label,
  value,
  hint,
  delta,
  betterDirection = "up",
  icon,
  accent = "primary",
}: KpiCardProps) {
  const deltaIsGood =
    delta && delta.direction !== "flat"
      ? delta.direction === betterDirection
      : null;

  const DeltaIcon =
    delta?.direction === "up"
      ? ArrowUpRight
      : delta?.direction === "down"
        ? ArrowDownRight
        : Minus;

  return (
    <Card className="p-5 shadow-sm hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1.5 min-w-0">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {label}
          </p>
          <p className="text-2xl font-semibold tabular-nums tracking-tight text-foreground truncate">
            {value}
          </p>
          {(hint || delta) && (
            <div className="flex items-center gap-2 text-xs">
              {delta && (
                <span
                  className={cn(
                    "inline-flex items-center gap-0.5 font-medium",
                    deltaIsGood === true && "text-success",
                    deltaIsGood === false && "text-destructive",
                    deltaIsGood === null && "text-muted-foreground"
                  )}
                >
                  <DeltaIcon className="h-3 w-3" />
                  {delta.label}
                </span>
              )}
              {hint && <span className="text-muted-foreground">{hint}</span>}
            </div>
          )}
        </div>
        {icon && (
          <div
            className={cn(
              "shrink-0 rounded-md w-9 h-9 flex items-center justify-center",
              accentClasses[accent]
            )}
          >
            {icon}
          </div>
        )}
      </div>
    </Card>
  );
}
