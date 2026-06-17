import { createPluginAtomClient } from "@executor-js/sdk/client";
import {
  getExecutorApiRequestBaseUrl,
  getExecutorServerAuthorizationHeader,
} from "@executor-js/react/api/server-connection";
import { OpenApiGroup } from "../api/group";

export const OpenApiClient = createPluginAtomClient(OpenApiGroup, {
  baseUrl: getExecutorApiRequestBaseUrl,
  authorizationHeader: getExecutorServerAuthorizationHeader,
});
