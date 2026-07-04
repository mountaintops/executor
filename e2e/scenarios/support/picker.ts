// Shared helper for the provider fan-out pickers (Google products, Microsoft
// workloads). Each preset checkbox is a Radix `<button role="checkbox">` wrapped
// in a `<label>` (FieldLabel). A single programmatic click can bubble to the
// label and re-dispatch to the control, double-toggling it (net no change), so a
// bare Playwright `check()`/`uncheck()` is racy here and errors with "Clicking
// the checkbox did not change its state". Drive the box to a known state by
// reading `aria-checked` and clicking only while it disagrees, polling until it
// settles.
import { expect } from "@effect/vitest";
import type { Page } from "playwright";

export const setPresetChecked = async (
  page: Page,
  presetId: string,
  checked: boolean,
): Promise<void> => {
  const box = page.getByTestId(`preset-checkbox-${presetId}`);
  await box.waitFor();
  await expect
    .poll(
      async () => {
        if ((await box.getAttribute("aria-checked")) === String(checked)) return String(checked);
        await box.click();
        return box.getAttribute("aria-checked");
      },
      { timeout: 10_000, interval: 200 },
    )
    .toBe(String(checked));
};
