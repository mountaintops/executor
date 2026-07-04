// Google per-service OAuth connect + auto-naming + ledger (the intended shape):
// boot the Google emulator, add ONE per-service integration pointed at the
// emulator's Discovery + OAuth, drive the browser add-account OAuth flow
// (auto-approving emulator consent), then assert the connection was created,
// its identityLabel was auto-filled from the emulator account's email (the
// userinfo health-check identity branch), and a tool call landed in the
// emulator ledger with the right auth.
//
// BLOCKED (pre-existing, not this PR): the Google per-service add path hardcodes
// its upstreams to real Google, with NO override toward an emulator:
//
//   * Discovery host: `google.addServices` resolves each preset through
//     `googleBundleUrlsWithIdentity` → `normalizeGoogleDiscoveryUrl`, which only
//     accepts `https://www.googleapis.com/...` (or `<svc>.googleapis.com`) HTTPS
//     Discovery endpoints. The emulator serves Discovery at
//     `http://127.0.0.1:<port>/discovery/v1/apis/...`, which the normalizer
//     rejects. The `baseUrl` payload field is stored as integration config only;
//     it does NOT redirect the Discovery fetch.
//     (packages/plugins/google/src/sdk/discovery.ts, sdk/plugin.ts)
//
//   * OAuth authorize/token: the converted spec bakes
//     `authorizationUrl = https://accounts.google.com/o/oauth2/v2/auth` and
//     `tokenUrl = https://oauth2.googleapis.com/token` into the integration's
//     `googleOAuth2` template (googleOauthTemplate in discovery.ts). There is no
//     per-integration override to point these at the emulator's `/o/oauth2/v2/auth`
//     + `/token`, so a browser consent can't be redirected at the emulator's
//     auto-approving pages the way the WorkOS/Microsoft emulator flows are.
//
//   * The Google emulator's OAuth credential mint returns only client_id /
//     client_secret (no authorization_url / token_url), unlike the Microsoft
//     emulator, so even the microsoft-emulator.test.ts trick of creating an
//     oauth client with emulator URLs has nothing to point at.
//
// Making this real needs the add path to accept a per-integration Discovery +
// OAuth endpoint override (emulator base), or a Google emulator that serves a
// googleapis.com-shaped Discovery host the normalizer accepts. Tracked
// separately. The picker fan-out itself IS covered end-to-end (against real
// Google Discovery, read-only) in google-per-service-add-ui.test.ts.
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Target } from "../src/services";

scenario(
  "Google · per-service OAuth against the emulator auto-names the connection and lands in the ledger",
  {
    skip: "google.addServices hardcodes Discovery (googleapis.com) and OAuth (accounts.google.com/oauth2.googleapis.com); no per-integration emulator override, and the Google emulator mint returns no authorization_url/token_url to point a client at",
    timeout: 180_000,
  },
  Effect.gen(function* () {
    yield* Target;
  }),
);
