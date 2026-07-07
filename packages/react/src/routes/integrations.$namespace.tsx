import { Schema } from "effect";
import { createFileRoute } from "@tanstack/react-router";

import { IntegrationDetailPage } from "../pages/integration-detail";

const SearchParams = Schema.toStandardSchemaV1(
  Schema.Struct({
    tab: Schema.optional(Schema.Literals(["accounts", "source", "tools"])),
  }),
);

export const Route = createFileRoute("/{-$orgSlug}/integrations/$namespace")({
  validateSearch: SearchParams,
  component: () => {
    const { namespace } = Route.useParams();
    const { tab } = Route.useSearch();
    return <IntegrationDetailPage namespace={namespace} tab={tab} />;
  },
});
