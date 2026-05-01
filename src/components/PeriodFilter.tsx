import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { PERIODOS, type PeriodoKey } from "@/lib/vendas/aggregations";

interface Props {
  value: PeriodoKey;
  onChange: (v: PeriodoKey) => void;
}

export function PeriodFilter({ value, onChange }: Props) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(v) => v && onChange(v as PeriodoKey)}
      variant="outline"
      size="sm"
      className="bg-card"
    >
      {PERIODOS.map((p) => (
        <ToggleGroupItem
          key={p.key}
          value={p.key}
          className="data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:border-primary"
        >
          {p.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
