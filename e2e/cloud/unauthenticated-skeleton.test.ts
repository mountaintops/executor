// Cloud-specific: what a SIGNED-OUT visitor gets at the app's pages.
//
// Born as the repro for the "bad skeleton on unauthed state" report: the root
// AuthGate used to SSR the AUTHENTICATED app-shell skeleton (sidebar + card
// grid) for every visitor and only swap to a login page after a client-side
// `/account/me` 401 — signed-out users were shown an app they'd never reach.
// Now the SSR auth gate (apps/cloud/src/auth/ssr-gate.ts) verifies the sealed
// session cookie in the worker and 302s signed-out document requests to
// /login (carrying ?returnTo=), so the app shell never exists for them.
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";

scenario(
  "Unauthenticated · the signed-out cloud root lands on /login with no app-shell flash",
  {},
  Effect.gen(function* () {
    const browser = yield* Browser;

    // No cookies, no headers → the browser context carries no session.
    const anonymous = { label: "anonymous" };

    yield* browser.session(anonymous, async ({ page, step }) => {
      // Hold the auth probe open: the old bug lived exactly in this window
      // (skeleton shown until /account/me resolved). The page must now be
      // login-shaped even while it's pending.
      await page.route("**/api/account/me", async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await route.continue();
      });

      await step("Open the cloud root while signed out → redirected to /login", async () => {
        await page.goto("/", { waitUntil: "commit" });
        await page.getByText("Sign in to manage your tools and sources").waitFor();
      });

      // Snapshot DURING the /account/me window — where the skeleton used to be.
      const duringLoading = {
        url: new URL(page.url()).pathname,
        appShellSkeletons: await page.locator('[data-slot="skeleton"]').count(),
        sidebarShown: await page.locator("aside").first().isVisible(),
        loginShown: await page.getByText("Sign in to manage your tools and sources").isVisible(),
      };

      expect(
        duringLoading,
        "A signed-out visitor is served the login page directly — never the " +
          "authenticated app-shell skeleton (sidebar nav + content-card grid).",
      ).toEqual({ url: "/login", appShellSkeletons: 0, sidebarShown: false, loginShown: true });
    });
  }),
);

scenario(
  "Unauthenticated · a deep link survives login: gate → /login?returnTo → callback lands back on it",
  {},
  Effect.gen(function* () {
    // Gate: the REST API plane is mounted on this target.
    yield* Api;
    const target = yield* Target;

    const cookiePair = (response: Response, name: string): string | undefined => {
      for (const header of response.headers.getSetCookie()) {
        if (header.startsWith(`${name}=`)) return header.split(";")[0];
      }
      return undefined;
    };

    // 1. A signed-out DOCUMENT request for a deep page is redirected to
    //    /login carrying the original path.
    const gated = yield* Effect.promise(() =>
      fetch(new URL("/tools", target.baseUrl), {
        redirect: "manual",
        headers: { accept: "text/html" },
      }),
    );
    expect(gated.status, "the page itself is never served signed-out").toBe(302);
    expect(gated.headers.get("location"), "login knows where the visitor was headed").toBe(
      "/login?returnTo=%2Ftools",
    );

    // 2. Starting login with that returnTo pins it in a short-lived cookie
    //    beside the CSRF state.
    const login = yield* Effect.promise(() =>
      fetch(new URL("/api/auth/login?returnTo=%2Ftools", target.baseUrl), {
        redirect: "manual",
      }),
    );
    expect(login.status, "login hands the browser to AuthKit").toBe(302);
    const stateCookie = cookiePair(login, "wos-login-state");
    const returnToCookie = cookiePair(login, "wos-login-return-to");
    expect(returnToCookie, "the destination travels with the login state").toBe(
      "wos-login-return-to=%2Ftools",
    );

    // 3. Complete the hosted flow (the emulator signs in headlessly via
    //    login_hint) — the callback sends the user to the deep link, not "/".
    const authorizeUrl = new URL(login.headers.get("location") ?? "");
    authorizeUrl.searchParams.set("login_hint", `returnto-${Date.now()}@e2e.test`);
    const consent = yield* Effect.promise(() => fetch(authorizeUrl, { redirect: "manual" }));
    const callbackUrl = consent.headers.get("location");
    expect(callbackUrl, "AuthKit redirects back to the app's callback").toBeTruthy();

    const callback = yield* Effect.promise(() =>
      fetch(callbackUrl!, {
        redirect: "manual",
        headers: { cookie: `${stateCookie}; ${returnToCookie}` },
      }),
    );
    expect(callback.status, "the callback completes the login").toBe(302);
    expect(
      callback.headers.get("location"),
      "…and resumes exactly where the gate interrupted the visitor",
    ).toBe("/tools");
    expect(cookiePair(callback, "wos-session"), "with a real session cookie minted").toBeTruthy();

    // 4. The returnTo channel never becomes an open redirect: an off-origin
    //    destination is dropped before it's even recorded.
    const forged = yield* Effect.promise(() =>
      fetch(new URL("/api/auth/login?returnTo=https%3A%2F%2Fevil.example", target.baseUrl), {
        redirect: "manual",
      }),
    );
    expect(
      cookiePair(forged, "wos-login-return-to"),
      "an off-origin returnTo is not recorded",
    ).toBeUndefined();
  }),
);

scenario(
  "Unauthenticated · a signed-in session still opens the app shell (the gate lets it through)",
  {},
  Effect.gen(function* () {
    const browser = yield* Browser;
    const target = yield* Target;
    const identity = yield* target.newIdentity();

    yield* browser.session(identity, async ({ page, step }) => {
      await step("Open the cloud root signed in", async () => {
        await page.goto("/", { waitUntil: "commit" });
        await page.locator("aside").first().waitFor({ state: "visible" });
      });
      expect(new URL(page.url()).pathname, "no login detour for a valid session").toBe("/");
    });

    // A signed-in visitor landing on /login is bounced back into the app.
    const loginWhileSignedIn = yield* Effect.promise(() =>
      fetch(new URL("/login", target.baseUrl), {
        redirect: "manual",
        headers: { accept: "text/html", ...identity.headers },
      }),
    );
    expect(loginWhileSignedIn.status, "/login is for signed-out visitors").toBe(302);
    expect(loginWhileSignedIn.headers.get("location")).toBe("/");
  }),
);

scenario(
  "Unauthenticated · unknown paths are a real 404 page, not a skeleton or a blank app",
  {},
  Effect.gen(function* () {
    const browser = yield* Browser;
    const target = yield* Target;
    const identity = yield* target.newIdentity();

    yield* browser.session(identity, async ({ page, step }) => {
      await step("Open a path that doesn't exist", async () => {
        await page.goto("/this-page-does-not-exist", { waitUntil: "commit" });
        await page.getByText("Page not found").waitFor();
      });
      expect(
        await page.locator('[data-slot="skeleton"]').count(),
        "no app-shell skeleton on the 404 page",
      ).toBe(0);
    });
  }),
);
