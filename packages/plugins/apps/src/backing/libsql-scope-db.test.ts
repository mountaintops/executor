import { scopeDbConformance } from "../seams/scope-db.conformance";
import { makeLibsqlScopeDb } from "./libsql-scope-db";
import { makeInProcessLiveChannel } from "./in-process-live-channel";

scopeDbConformance(
  "libsql (in-memory)",
  () => makeLibsqlScopeDb({ root: ":memory:" }),
  () => makeInProcessLiveChannel(),
);
