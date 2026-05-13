import { useState } from "react";
import { Calendar as CalendarIcon, ChevronDown } from "lucide-react";
import { format, parseISO } from "date-fns";
import { ptBR } from "date-fns/locale";
import type { DateRange } from "react-day-picker";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  BACKWARD_PRESETS,
  PERIOD_LABELS,
  computeRange,
  type PeriodPreset,
  type PeriodRange,
} from "@/lib/dashboard/period";

interface Props {
  value: PeriodRange;
  onChange: (range: PeriodRange) => void;
  presets?: PeriodPreset[];
}

export function DashboardPeriodFilter({ value, onChange, presets }: Props) {
  const PRESETS = presets ?? BACKWARD_PRESETS;
  const [customOpen, setCustomOpen] = useState(false);
  const [draft, setDraft] = useState<DateRange | undefined>(
    value.preset === "custom"
      ? { from: parseISO(value.from), to: parseISO(value.to) }
      : undefined,
  );

  const label =
    value.preset === "custom"
      ? `${format(parseISO(value.from), "dd MMM", { locale: ptBR })} – ${format(
          parseISO(value.to),
          "dd MMM yyyy",
          { locale: ptBR },
        )}`
      : PERIOD_LABELS[value.preset];

  const handlePreset = (preset: PeriodPreset) => {
    const r = computeRange(preset);
    onChange({ preset, ...r });
  };

  const applyCustom = () => {
    if (draft?.from && draft?.to) {
      onChange({
        preset: "custom",
        from: format(draft.from, "yyyy-MM-dd"),
        to: format(draft.to, "yyyy-MM-dd"),
      });
      setCustomOpen(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="gap-2 bg-card">
            <CalendarIcon className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="font-medium">{label}</span>
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          {PRESETS.map((p) => (
            <DropdownMenuItem
              key={p}
              onSelect={() => handlePreset(p)}
              className={cn(
                "cursor-pointer",
                value.preset === p && "bg-accent text-accent-foreground",
              )}
            >
              {PERIOD_LABELS[p]}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <Popover open={customOpen} onOpenChange={setCustomOpen}>
            <PopoverTrigger asChild>
              <DropdownMenuItem
                onSelect={(e) => {
                  e.preventDefault();
                  setCustomOpen(true);
                }}
                className={cn(
                  "cursor-pointer",
                  value.preset === "custom" && "bg-accent text-accent-foreground",
                )}
              >
                {PERIOD_LABELS.custom}…
              </DropdownMenuItem>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-auto p-0" side="left">
              <Calendar
                mode="range"
                numberOfMonths={2}
                selected={draft}
                onSelect={setDraft}
                locale={ptBR}
                className={cn("p-3 pointer-events-auto")}
              />
              <div className="flex items-center justify-end gap-2 border-t p-3">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setCustomOpen(false)}
                >
                  Cancelar
                </Button>
                <Button
                  size="sm"
                  onClick={applyCustom}
                  disabled={!draft?.from || !draft?.to}
                >
                  Aplicar
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
