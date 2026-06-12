import { useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAtomValue, useAtomSet } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Exit from "effect/Exit";
import { authWriteKeys } from "@executor-js/react/api/reactivity-keys";

import { organizationsAtom, switchOrganization } from "../auth";

// ---------------------------------------------------------------------------
// Foreign-slug resolution for the cloud org-slug gate: the URL carries a slug
// that isn't the active org's. If the caller is a member of that org (their
// bookmark, a teammate's link into a shared org), switch the session to it
// and reload so the whole app re-scopes. Otherwise canonicalize back to the
// active org — the slug is a selector, not an access grant, so an unknown or
// unauthorized slug just snaps to the org the session actually has.
// ---------------------------------------------------------------------------

export function ForeignOrgSlug(props: { readonly slug: string; readonly activeSlug: string }) {
  const organizations = useAtomValue(organizationsAtom);
  const doSwitchOrganization = useAtomSet(switchOrganization, { mode: "promiseExit" });
  const navigate = useNavigate();
  const resolving = useRef(false);

  const target = AsyncResult.match(organizations, {
    onInitial: () => null,
    onFailure: () => "none" as const,
    onSuccess: ({ value }) =>
      value.organizations.find((org: { slug: string }) => org.slug === props.slug) ??
      ("none" as const),
  });

  useEffect(() => {
    if (target === null || resolving.current) return;
    resolving.current = true;
    if (target === "none") {
      void navigate({
        to: ".",
        params: (previous: Record<string, string>) => ({
          ...previous,
          orgSlug: props.activeSlug,
        }),
        replace: true,
      });
      return;
    }
    void doSwitchOrganization({
      payload: { organizationId: target.id },
      reactivityKeys: authWriteKeys,
    }).then((exit) => {
      // Keep the URL (it already names the target org); reload re-scopes the
      // app to the switched session. On failure fall back to canonicalizing.
      if (Exit.isSuccess(exit)) {
        window.location.reload();
      } else {
        void navigate({
          to: ".",
          params: (previous: Record<string, string>) => ({
            ...previous,
            orgSlug: props.activeSlug,
          }),
          replace: true,
        });
      }
    });
  }, [target, props.activeSlug, doSwitchOrganization, navigate, props.slug]);

  return (
    <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
      Switching organization…
    </div>
  );
}
