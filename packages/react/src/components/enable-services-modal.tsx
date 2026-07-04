import { useMemo, useState } from "react";
import {
  AuthTemplateSlug,
  IntegrationSlug,
  type AuthMethodDescriptor,
  type Connection,
  type Owner,
} from "@executor-js/sdk/shared";
import { CheckCircle2Icon, RotateCcwIcon, XCircleIcon } from "lucide-react";
import { toast } from "sonner";

import { useOrganizationId } from "../api/organization-context";
import { normalizeEmail, type ProviderAccount } from "../lib/provider-accounts";
import { cn } from "../lib/utils";
import { useOAuthPopupFlow, type OAuthStartPayload } from "../plugins/oauth-sign-in";
import { Button } from "./button";
import { Badge } from "./badge";
import { Checkbox } from "./checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./dialog";
import { Label } from "./label";
import { connectionLabelForHost, connectionNameFrom } from "./add-account-modal";

export type EnableServiceIntegration = {
  readonly slug: IntegrationSlug;
  readonly name: string;
  readonly kind: string;
  readonly authMethods: readonly AuthMethodDescriptor[];
};

export type EnableServiceStepStatus = "pending" | "done" | "failed";

export type EnableServiceQueueStep<TIntegration extends EnableServiceIntegration> = {
  readonly integration: TIntegration;
  readonly status: EnableServiceStepStatus;
};

export type EnableServiceQueue<TIntegration extends EnableServiceIntegration> = {
  readonly steps: readonly EnableServiceQueueStep<TIntegration>[];
  readonly activeIndex: number;
};

export const createEnableServicesQueue = <TIntegration extends EnableServiceIntegration>(
  integrations: readonly TIntegration[],
): EnableServiceQueue<TIntegration> => ({
  steps: integrations.map((integration) => ({ integration, status: "pending" })),
  activeIndex: 0,
});

const nextPendingIndex = <TIntegration extends EnableServiceIntegration>(
  steps: readonly EnableServiceQueueStep<TIntegration>[],
  from: number,
): number => {
  const next = steps.findIndex((step, index) => index > from && step.status !== "done");
  return next === -1 ? steps.length : next;
};

export const applyEnableServiceStepResult = <TIntegration extends EnableServiceIntegration>(
  queue: EnableServiceQueue<TIntegration>,
  slug: IntegrationSlug,
  status: EnableServiceStepStatus,
): EnableServiceQueue<TIntegration> => {
  const stepIndex = queue.steps.findIndex((step) => step.integration.slug === slug);
  if (stepIndex === -1) return queue;
  const steps = queue.steps.map((step, index) =>
    index === stepIndex ? { ...step, status } : step,
  );
  return {
    steps,
    activeIndex:
      status === "done" && stepIndex === queue.activeIndex
        ? nextPendingIndex(steps, stepIndex)
        : queue.activeIndex,
  };
};

export const retryEnableServiceStep = <TIntegration extends EnableServiceIntegration>(
  queue: EnableServiceQueue<TIntegration>,
  slug: IntegrationSlug,
): EnableServiceQueue<TIntegration> => {
  const stepIndex = queue.steps.findIndex((step) => step.integration.slug === slug);
  if (stepIndex === -1) return queue;
  return {
    steps: queue.steps.map((step, index) =>
      index === stepIndex ? { ...step, status: "pending" } : step,
    ),
    activeIndex: stepIndex,
  };
};

export const activeEnableServiceStep = <TIntegration extends EnableServiceIntegration>(
  queue: EnableServiceQueue<TIntegration>,
): EnableServiceQueueStep<TIntegration> | null => queue.steps[queue.activeIndex] ?? null;

const oauthMethodFor = (integration: EnableServiceIntegration): AuthMethodDescriptor | null =>
  integration.authMethods.find((method) => method.kind === "oauth") ?? null;

const mirrorConnectionFor = (
  account: ProviderAccount<Connection, EnableServiceIntegration>,
): Connection | null =>
  account.connections.find((entry) => entry.connection.oauthClient != null)?.connection ?? null;

export const buildEnableServiceOAuthStartPayload = (input: {
  readonly account: ProviderAccount<Connection, EnableServiceIntegration>;
  readonly integration: EnableServiceIntegration;
  readonly organizationId: string | null;
}): OAuthStartPayload | null => {
  const loginHint = normalizeEmail(input.account.label);
  if (loginHint === null) return null;
  const method = oauthMethodFor(input.integration);
  if (!method) return null;
  const mirrored = mirrorConnectionFor(input.account);
  if (!mirrored?.oauthClient) return null;
  const owner = input.account.owner as Owner;
  const identityLabel = connectionLabelForHost(
    "",
    owner,
    input.integration.name,
    input.organizationId,
  );

  return {
    client: mirrored.oauthClient,
    clientOwner: mirrored.oauthClientOwner ?? mirrored.owner,
    owner,
    name: connectionNameFrom("", owner, input.integration.name, input.organizationId),
    integration: input.integration.slug,
    template: AuthTemplateSlug.make(method.template),
    identityLabel,
    loginHint,
  };
};

const serviceKey = (integration: EnableServiceIntegration): string => String(integration.slug);

export function EnableServicesModal(props: {
  readonly open: boolean;
  readonly account: ProviderAccount<Connection, EnableServiceIntegration> | null;
  readonly integrations: readonly EnableServiceIntegration[];
  readonly onOpenChange: (open: boolean) => void;
}) {
  if (!props.open || !props.account) return null;
  return <EnableServicesModalBody {...props} account={props.account} />;
}

function EnableServicesModalBody(props: {
  readonly account: ProviderAccount<Connection, EnableServiceIntegration>;
  readonly integrations: readonly EnableServiceIntegration[];
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
}) {
  const organizationId = useOrganizationId();
  const defaultSelected = useMemo(
    () =>
      new Set(
        props.integrations
          .filter((integration) => oauthMethodFor(integration) !== null)
          .map((integration) => serviceKey(integration)),
      ),
    [props.integrations],
  );
  const [selected, setSelected] = useState<ReadonlySet<string>>(defaultSelected);
  const [queue, setQueue] = useState<EnableServiceQueue<EnableServiceIntegration> | null>(null);
  const oauthPopup = useOAuthPopupFlow({
    popupName: "enable-provider-service",
    detectPopupClosed: false,
    startErrorMessage: "Failed to start service connection",
  });
  const active = queue ? activeEnableServiceStep(queue) : null;
  const selectedIntegrations = props.integrations.filter((integration) =>
    selected.has(serviceKey(integration)),
  );
  const complete = queue ? queue.steps.every((step) => step.status === "done") : false;
  const loginHint = normalizeEmail(props.account.label);

  const toggleSelected = (integration: EnableServiceIntegration, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(serviceKey(integration));
      else next.delete(serviceKey(integration));
      return next;
    });
  };

  const startQueue = () => {
    setQueue(createEnableServicesQueue(selectedIntegrations));
  };

  const markActive = (status: EnableServiceStepStatus) => {
    if (!queue || !active) return;
    setQueue(applyEnableServiceStepResult(queue, active.integration.slug, status));
  };

  const handleContinue = () => {
    if (!active) return;
    const payload = buildEnableServiceOAuthStartPayload({
      account: props.account,
      integration: active.integration,
      organizationId,
    });
    if (!payload) {
      markActive("failed");
      toast.error("This service cannot reuse the selected OAuth app");
      return;
    }
    void oauthPopup.start({
      payload,
      onSuccess: () => {
        markActive("done");
        toast.success(`${active.integration.name} connected`);
      },
      onError: () => {
        markActive("failed");
      },
    });
  };

  const handleRetry = () => {
    if (!queue || !active) return;
    setQueue(retryEnableServiceStep(queue, active.integration.slug));
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add services</DialogTitle>
          <DialogDescription>{loginHint ?? props.account.label}</DialogDescription>
        </DialogHeader>

        {queue === null ? (
          <div className="space-y-3">
            <div className="rounded-md border border-border">
              {props.integrations.map((integration) => {
                const key = serviceKey(integration);
                const disabled = oauthMethodFor(integration) === null || loginHint === null;
                return (
                  <Label
                    key={key}
                    className={cn(
                      "flex cursor-pointer items-center gap-3 border-b border-border px-3 py-3 last:border-b-0",
                      disabled && "cursor-not-allowed opacity-50",
                    )}
                  >
                    <Checkbox
                      checked={selected.has(key)}
                      disabled={disabled}
                      onCheckedChange={(value) => toggleSelected(integration, value === true)}
                    />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate text-sm font-medium text-foreground">
                        {integration.name}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {disabled ? "OAuth is not available" : "Ready to connect"}
                      </span>
                    </span>
                  </Label>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              {queue.steps.map((step, index) => (
                <div
                  key={serviceKey(step.integration)}
                  className="flex items-center justify-between rounded-md border border-border px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {step.integration.name}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {index + 1} of {queue.steps.length}
                    </p>
                  </div>
                  {step.status === "done" ? (
                    <Badge variant="outline" className="gap-1 text-emerald-700">
                      <CheckCircle2Icon />
                      Done
                    </Badge>
                  ) : step.status === "failed" ? (
                    <Badge variant="outline" className="gap-1 text-destructive">
                      <XCircleIcon />
                      Failed
                    </Badge>
                  ) : (
                    <Badge variant="outline">Pending</Badge>
                  )}
                </div>
              ))}
            </div>

            {complete ? (
              <div className="rounded-md border border-border bg-muted/30 px-3 py-3 text-sm text-foreground">
                Selected services are connected.
              </div>
            ) : active ? (
              <div className="rounded-md border border-border bg-muted/30 px-3 py-3">
                <p className="text-sm font-medium text-foreground">
                  Connecting {active.integration.name} ({queue.activeIndex + 1} of{" "}
                  {queue.steps.length})
                </p>
                {active.status === "failed" ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Retry this service when ready.
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        )}

        <DialogFooter>
          {queue === null ? (
            <Button
              type="button"
              onClick={startQueue}
              disabled={selectedIntegrations.length === 0 || loginHint === null}
            >
              Start queue
            </Button>
          ) : complete ? (
            <Button type="button" onClick={() => props.onOpenChange(false)}>
              Done
            </Button>
          ) : active?.status === "failed" ? (
            <Button type="button" onClick={handleRetry} variant="outline">
              <RotateCcwIcon />
              Retry
            </Button>
          ) : (
            <Button type="button" onClick={handleContinue} loading={oauthPopup.busy}>
              Continue
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
