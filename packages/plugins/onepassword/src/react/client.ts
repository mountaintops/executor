import { createPluginAtomClient } from "@executor-js/sdk/client";
import {
  getExecutorApiRequestBaseUrl,
  getExecutorServerAuthorizationHeader,
} from "@executor-js/react/api/server-connection";
import { OnePasswordGroup } from "../api/group";

export const OnePasswordClient = createPluginAtomClient(OnePasswordGroup, {
  baseUrl: getExecutorApiRequestBaseUrl,
  authorizationHeader: getExecutorServerAuthorizationHeader,
});
