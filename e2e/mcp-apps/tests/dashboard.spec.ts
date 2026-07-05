import { test, expect } from "sunpeak/test";

// executor apps serve a published UI view (`ui://<scope>/dashboard`) as a
// complete, self-booting MCP-Apps HTML document (React + the executor:ui runtime
// + the compiled component + the current scope-db rows, all inline). The
// `apps_open_ui` tool declares `_meta.ui.resourceUri` linking to that resource,
// so a real MCP-Apps host renders the widget when the tool runs.
//
// This spec proves the widget actually MOUNTS and RENDERS rows from the scope db
// inside a simulated host. sunpeak runs it against BOTH the Claude and ChatGPT
// host simulations (Playwright projects).

// Our published document mounts the component directly inside the host's sandbox
// iframe. sunpeak's `result.app()` already descends one nested iframe; if our
// shell ever nests a further srcdoc iframe, add one more `.frameLocator("iframe")`
// descent here (see README).
const appBody = (result: { app: () => ReturnType<ReturnType<typeof test>["app"]> } | any) =>
  result.app();

test("the published dashboard mounts and renders scope-db issue rows", async ({ inspector }) => {
  // No input: `apps_open_ui` takes none. sunpeak renders the tool's declared
  // ui resource (`_meta.ui.resourceUri` -> ui://<scope>/dashboard) in the host
  // sandbox.
  const result = await inspector.renderTool("apps_open_ui");
  const app = appBody(result);

  // The widget's chrome renders (proves React mounted inside the host sandbox).
  await expect(app.getByText("Open issues", { exact: true })).toBeVisible({
    timeout: 30_000,
  });

  // The scope-db rows the server inlined render: the daily-brief `issues-sync`
  // populated the `issues` table (2 issues) from the GitHub emulator, and the
  // dashboard shows the live count + lists each `repo#number`.
  await expect(app.getByText("2 open issues")).toBeVisible({ timeout: 30_000 });
  await expect(app.getByText(/\/app#\d+/).first()).toBeVisible({
    timeout: 30_000,
  });
});
