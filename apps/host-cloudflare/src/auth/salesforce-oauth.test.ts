import { describe, expect, it } from "vitest";
import { generateCodeChallenge, generateCodeVerifier } from "./salesforce-oauth";

describe("Salesforce PKCE OAuth Generator", () => {
  it("should generate a valid 43-character base64url PKCE verifier", async () => {
    const verifier = await generateCodeVerifier();
    expect(verifier).toBeDefined();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    // Base64URL characters only (a-z, A-Z, 0-9, -, _)
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("should generate a valid SHA-256 S256 code challenge from verifier", async () => {
    const verifier = await generateCodeVerifier();
    const challenge = await generateCodeChallenge(verifier);

    expect(challenge).toBeDefined();
    expect(challenge.length).toBeGreaterThanOrEqual(43);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).not.toEqual(verifier);
  });
});
