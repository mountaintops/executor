// Local-only: custom tool local-directory sources can browse the user's own
// filesystem through the local app. The shared self-host target intentionally
// does not expose this source kind.
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Cli, RunDir, Target } from "../src/services";
import { withLocalServer } from "./local-server";

scenario(
  "Local custom tools · the directory picker selects a local source path",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const cli = yield* Cli;
    const browser = yield* Browser;
    const target = yield* Target;
    const runDir = yield* RunDir;
    const identity = yield* target.newIdentity();
    const fixtureRoot = mkdtempSync(join(homedir(), ".executor-picker-e2e-"));
    const fixtureDir = join(fixtureRoot, "picked-tools");
    mkdirSync(fixtureDir);

    yield* withLocalServer(cli, runDir, ({ url }) =>
      browser.session(identity, async ({ page, step }) => {
        await step("Open custom tools from the local console", async () => {
          const addSourceUrl = new URL(url);
          addSourceUrl.pathname = "/integrations/add/apps";
          await page.goto(addSourceUrl.toString(), {
            waitUntil: "domcontentloaded",
          });
          await page.getByRole("heading", { name: "Add custom tools" }).waitFor({
            timeout: 60_000,
          });
        });

        await step("Browse to a local directory and select it", async () => {
          await page.getByRole("button", { name: "Directory path" }).click();
          const pathInput = page.getByPlaceholder("/Users/me/tools");
          await pathInput.fill(fixtureRoot);
          await page.getByRole("button", { name: "Browse" }).click();
          const dialog = page.getByRole("dialog", { name: "Choose directory" });
          await dialog.getByRole("button", { name: "picked-tools" }).click();
          await dialog.getByRole("button", { name: "Select" }).click();
          expect(await pathInput.inputValue()).toBe(fixtureDir);
        });
      }),
    ).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(fixtureRoot, { recursive: true, force: true }))),
    );
  }),
);
