import { lazy } from "react";
import type { IntegrationPlugin } from "@executor-js/sdk/client";

import { CUSTOM_TOOLS_LABEL, CUSTOM_TOOLS_PLUGIN_KEY } from "./custom-tools-client";

const importAdd = () => import("./AddCustomToolsSource");
const importAccounts = () => import("./CustomToolsAccountsPanel");

export const appsIntegrationPlugin: IntegrationPlugin = {
  key: CUSTOM_TOOLS_PLUGIN_KEY,
  label: CUSTOM_TOOLS_LABEL,
  add: lazy(importAdd),
  accounts: lazy(importAccounts),
  preload: () => {
    void importAdd();
    void importAccounts();
  },
};
