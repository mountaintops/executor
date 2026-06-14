import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { Button } from "./button";
import { cn } from "../lib/utils";
import { copyToClipboard } from "../lib/clipboard";

function CopyButton({
  value,
  label,
  className,
  onCopy,
  kind,
}: {
  value: string;
  label?: string;
  className?: string;
  /** Fires after a successful copy. Receives nothing — the copied value may be sensitive. */
  onCopy?: () => void;
  kind?: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    void copyToClipboard(value, { kind: kind ?? "copy_button" }).then((success) => {
      if (success) {
        setCopied(true);
        onCopy?.();
        setTimeout(() => setCopied(false), 1500);
      }
    });
  };

  if (label) {
    return (
      <Button
        variant="ghost"
        size="xs"
        onClick={handleCopy}
        className={cn("text-muted-foreground", className)}
        title={label}
      >
        {copied ? <Check /> : <Copy />}
        {copied ? "Copied" : label}
      </Button>
    );
  }

  return (
    <Button
      variant="ghost"
      size="icon-xs"
      onClick={handleCopy}
      className={cn("shrink-0 text-muted-foreground", className)}
      title="Copy"
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}

export { CopyButton };
