import { describe, expect, it } from "@effect/vitest";

import { annotationsForOperation } from "./invoke";

describe("annotationsForOperation", () => {
  it("uses default approval policy when no override is supplied", () => {
    expect(annotationsForOperation("get", "/items")).toEqual({});
    expect(annotationsForOperation("post", "/items")).toEqual({
      requiresApproval: true,
      approvalDescription: "POST /items",
    });
  });

  it("lets source policy replace the default method set", () => {
    const policy = { requireApprovalFor: ["get"] };

    expect(annotationsForOperation("get", "/items", policy)).toEqual({
      requiresApproval: true,
      approvalDescription: "GET /items",
    });
    expect(annotationsForOperation("post", "/items", policy)).toEqual({});
  });
});
