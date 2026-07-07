import { describe, expect, it } from "@effect/vitest";

import {
  integrationDetailInternalTabFromSearch,
  integrationDetailSearchTabForInternal,
  integrationDetailTabForAddCompletion,
} from "./integration-detail-tabs";

describe("integration detail tab routing", () => {
  it("lands custom-tools add completion on the same source tab a reload reads", () => {
    const addCompletionTab = integrationDetailTabForAddCompletion("apps");

    expect(addCompletionTab).toBe("source");
    expect(integrationDetailInternalTabFromSearch(addCompletionTab)).toBe("accounts");
    expect(integrationDetailSearchTabForInternal("apps", "accounts")).toBe(addCompletionTab);
  });

  it("keeps non-app integrations on the accounts/tools tab vocabulary", () => {
    expect(integrationDetailTabForAddCompletion("openapi")).toBeUndefined();
    expect(integrationDetailSearchTabForInternal("openapi", "accounts")).toBe("accounts");
    expect(integrationDetailSearchTabForInternal("openapi", "tools")).toBe("tools");
  });
});
