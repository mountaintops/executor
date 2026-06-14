import { trackEvent } from "../api/analytics";
import { reportHandledFrontendError } from "../api/error-reporting";

export async function copyToClipboard(text: string, meta?: { kind: string }): Promise<boolean> {
  const kind = meta?.kind ?? "unknown";

  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: DOM Clipboard API is an external, browser-only surface
    try {
      await navigator.clipboard.writeText(text);
      trackEvent("copy_succeeded", { secure: true, kind });
      return true;
    } catch (unknownCause) {
      reportHandledFrontendError(unknownCause, {
        surface: "clipboard",
        action: "clipboard_api_write",
        message: "Clipboard API rejected; falling back to execCommand",
        severity: "warning",
      });
      return legacyCopy(text, kind, true);
    }
  }

  return legacyCopy(text, kind, false);
}

function legacyCopy(text: string, kind: string, fallback: boolean): boolean {
  const activeElement = document.activeElement as HTMLElement | null;

  const span = document.createElement("span");
  span.textContent = text;
  span.style.position = "fixed";
  span.style.left = "-9999px";
  document.body.appendChild(span);

  const selection = document.getSelection();
  const range = document.createRange();
  range.selectNodeContents(span);
  selection?.removeAllRanges();
  selection?.addRange(range);

  // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: DOM execCommand copy is a browser-only adapter; we record failure without rethrowing
  try {
    const result = document.execCommand("copy");
    if (result) {
      trackEvent("copy_succeeded", { secure: false, kind });
      cleanup();
      return true;
    }

    reportHandledFrontendError("execCommand returned false", {
      surface: "clipboard",
      action: "legacy_copy",
      message: "execCommand copy failed; clipboard empty",
      severity: "warning",
    });
  } catch (unknownCause) {
    reportHandledFrontendError(unknownCause, {
      surface: "clipboard",
      action: "legacy_copy",
      message: "execCommand copy failed; clipboard empty",
      severity: "warning",
    });
  }

  trackEvent("copy_failed", { secure: false, kind, fallback });
  cleanup();
  return false;

  function cleanup(): void {
    selection?.removeAllRanges();
    document.body.removeChild(span);
    activeElement?.focus();
  }
}
