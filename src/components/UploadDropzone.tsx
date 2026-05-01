import { useCallback, useRef, useState } from "react";
import { FileSpreadsheet, Upload } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export interface UploadDropzoneProps {
  onFiles: (files: File[]) => void;
  accept: string;
  multiple?: boolean;
  title: string;
  hint?: string;
  loading?: boolean;
}

export function UploadDropzone({
  onFiles,
  accept,
  multiple = true,
  title,
  hint,
  loading,
}: UploadDropzoneProps) {
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handle = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0) return;
      onFiles(Array.from(files));
    },
    [onFiles]
  );

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        handle(e.dataTransfer.files);
      }}
      className={cn(
        "relative rounded-xl border-2 border-dashed bg-card transition-all",
        "p-8 text-center",
        over
          ? "border-primary bg-accent/40 scale-[1.005]"
          : "border-border hover:border-primary/40 hover:bg-accent/20",
        loading && "pointer-events-none opacity-60"
      )}
    >
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary mb-4">
        {loading ? (
          <div className="h-5 w-5 border-2 border-current border-r-transparent rounded-full animate-spin" />
        ) : (
          <FileSpreadsheet className="h-6 w-6" />
        )}
      </div>
      <h3 className="text-base font-semibold text-foreground mb-1">{title}</h3>
      {hint && (
        <p className="text-sm text-muted-foreground mb-4 max-w-md mx-auto">
          {hint}
        </p>
      )}
      <Button
        onClick={() => inputRef.current?.click()}
        disabled={loading}
        className="gap-2"
      >
        <Upload className="h-4 w-4" />
        {loading ? "Processando..." : "Selecionar arquivos"}
      </Button>
      <p className="mt-3 text-xs text-muted-foreground">
        ou arraste e solte aqui
      </p>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        onChange={(e) => handle(e.target.files)}
        className="hidden"
      />
    </div>
  );
}
