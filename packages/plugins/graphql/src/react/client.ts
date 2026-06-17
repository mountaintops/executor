import { createPluginAtomClient } from "@executor-js/sdk/client";
import {
  getExecutorApiRequestBaseUrl,
  getExecutorServerAuthorizationHeader,
} from "@executor-js/react/api/server-connection";
import { GraphqlGroup } from "../api/group";

export const GraphqlClient = createPluginAtomClient(GraphqlGroup, {
  baseUrl: getExecutorApiRequestBaseUrl,
  authorizationHeader: getExecutorServerAuthorizationHeader,
});
