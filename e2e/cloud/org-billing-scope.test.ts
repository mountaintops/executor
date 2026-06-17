// Cloud-only (billing): the member-seat gate scopes to the org in the URL, not
// the org the session cookie happens to be pinned to. This reproduces a
// production report — a multi-org admin opening a team-plan org by its slug
// still hit the free plan's 3-seat cap and got a 403 on the 3rd invite, because
// billing/account read the SESSION's org (a different, free org) instead of the
// org the URL named.
//
// The repro needs the two to disagree. Create a TEAM org first, then a FREE org
// last, so the refreshed session cookie ends pinned to the FREE org. Then drive
// every account call under the TEAM org's `/<slug>/api/...` URL with that
// free-pinned cookie: same cookie, two org URLs, two different answers. The URL
// is the only thing that selects the org — under the bug the session's free org
// capped the team org at 3.
//
// Black-box: drives only the public account API and seeds the Autumn emulator
// the cloud app already talks to (its customerId IS the WorkOS org id). The team
// org carries a SINGLE active `team` subscription — the shape Autumn returns
// after an upgrade (confirmed against a live response) — so the repro does not
// lean on any "free plan listed first" seat-math quirk; it isolates the
// URL-vs-session scoping bug alone.
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { connectEmulator } from "@executor-js/emulate";

import { scenario } from "../src/scenario";
import { Billing, Target } from "../src/services";
import { AUTUMN_EMULATOR_PORT } from "../targets/cloud";

interface Seats {
  readonly used: number;
  readonly granted: number;
  readonly unlimited: boolean;
}

interface CreatedOrg {
  readonly id: string;
  readonly slug: string;
  readonly cookie: string;
}

scenario(
  "Billing · member-seat limits follow the URL's org, not the session's pinned org",
  {},
  Effect.gen(function* () {
    // Gate: billing limits are enforced on this target (cloud).
    yield* Billing;
    const target = yield* Target;
    const origin = new URL(target.baseUrl).origin;

    // A fresh user with NO org. We create both orgs by hand so we control the
    // ORDER — the last one created is the org the refreshed session pins.
    const identity = yield* target.newIdentity({ org: false });
    const baseCookie = identity.headers?.cookie ?? "";

    const createOrg = (name: string, cookie: string) =>
      Effect.promise(async (): Promise<CreatedOrg> => {
        const response = await fetch(new URL("/api/auth/create-organization", target.baseUrl), {
          method: "POST",
          headers: { "content-type": "application/json", origin, cookie },
          body: JSON.stringify({ name }),
        });
        if (!response.ok) {
          throw new Error(`create-organization "${name}" failed (${response.status})`);
        }
        const body = (await response.json()) as { id: string; slug: string };
        const refreshed = (response.headers.getSetCookie?.() ?? [])
          .find((header) => header.startsWith("wos-session="))
          ?.split(";")[0];
        return { id: body.id, slug: body.slug, cookie: refreshed ?? cookie };
      });

    // TEAM org first, then FREE org last → the session cookie now pins FREE.
    const team = yield* createOrg("Seat Scope Team", baseCookie);
    const free = yield* createOrg("Seat Scope Free", team.cookie);
    const sessionCookie = free.cookie; // pinned to the FREE org
    expect(team.slug, "the two orgs have distinct slugs").not.toBe(free.slug);

    // Put the TEAM org on the team plan — a single active `team` subscription,
    // the shape Autumn returns after an upgrade. Its customerId is the WorkOS
    // org id the seat gate looks up.
    yield* Effect.promise(async () => {
      const autumn = await connectEmulator({
        baseUrl: `http://127.0.0.1:${AUTUMN_EMULATOR_PORT}`,
      });
      await autumn.seed({
        customers: [{ id: team.id, subscriptions: [{ plan_id: "team", status: "active" }] }],
      });
    });

    const seatsAt = (slug: string) =>
      Effect.promise(async (): Promise<Seats> => {
        const response = await fetch(new URL(`/${slug}/api/account/members`, target.baseUrl), {
          headers: { cookie: sessionCookie },
        });
        const body = (await response.json()) as { seats?: Seats };
        if (!body.seats) throw new Error(`members(${slug}) carried no seats (${response.status})`);
        return body.seats;
      });

    // The crux: ONE session cookie (pinned to the FREE org), two org URLs, two
    // different answers. A model that read the session org would report the free
    // cap for BOTH; the URL model reports the org each URL names.
    const teamSeats = yield* seatsAt(team.slug);
    expect(teamSeats.unlimited, "the team org's URL grants unlimited seats").toBe(true);

    const freeSeats = yield* seatsAt(free.slug);
    expect(freeSeats.unlimited, "the free org's URL is capped").toBe(false);
    expect(freeSeats.granted, "the free org's URL grants the free 3-seat cap").toBe(3);

    // The user-visible symptom: invites on the team org's URL. A fresh org has 1
    // member (the admin); on the buggy free cap the 3rd invite tips used→3 and is
    // refused 403. Under the fix every invite on the team org is accepted.
    const inviteToken = team.id.replace(/[^a-z0-9]/gi, "");
    const invite = (slug: string, email: string) =>
      Effect.promise(async () => {
        const response = await fetch(
          new URL(`/${slug}/api/account/members/invite`, target.baseUrl),
          {
            method: "POST",
            headers: { "content-type": "application/json", origin, cookie: sessionCookie },
            body: JSON.stringify({ email }),
          },
        );
        return response.status;
      });

    for (let i = 1; i <= 3; i++) {
      const status = yield* invite(team.slug, `seat-${i}-${inviteToken}@e2e.test`);
      expect(status, `invite ${i} on the team org's URL is accepted`).toBe(200);
    }
  }),
);
