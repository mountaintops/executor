export type ProviderAccountConnectionLike = {
  readonly owner: string;
  readonly name: unknown;
  readonly integration: unknown;
  readonly identityLabel?: string | null;
};

export type ProviderAccountIntegrationLike = {
  readonly slug: unknown;
  readonly kind: string;
};

export type ProviderAccountConnection<
  TConnection extends ProviderAccountConnectionLike = ProviderAccountConnectionLike,
  TIntegration extends ProviderAccountIntegrationLike = ProviderAccountIntegrationLike,
> = {
  readonly connection: TConnection;
  readonly integration: TIntegration;
};

export type ProviderAccount<
  TConnection extends ProviderAccountConnectionLike = ProviderAccountConnectionLike,
  TIntegration extends ProviderAccountIntegrationLike = ProviderAccountIntegrationLike,
> = {
  readonly family: string;
  readonly owner: TConnection["owner"];
  readonly identityKey: string;
  readonly label: string;
  readonly connections: readonly ProviderAccountConnection<TConnection, TIntegration>[];
};

export const MULTI_SERVICE_FAMILIES: ReadonlySet<string> = new Set(["google", "microsoft"]);

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const normalizeEmail = (value: string | null | undefined): string | null => {
  const normalized = value?.trim().toLowerCase() ?? "";
  return EMAIL_PATTERN.test(normalized) ? normalized : null;
};

const singletonIdentityKey = (connection: ProviderAccountConnectionLike, family: string): string =>
  `${String(connection.owner)}:${family}:${String(connection.integration)}:${String(
    connection.name,
  )}`;

const displayLabelFor = (connection: ProviderAccountConnectionLike): string => {
  const label = connection.identityLabel?.trim();
  return label && label.length > 0 ? label : String(connection.name);
};

export function groupProviderAccounts<
  TConnection extends ProviderAccountConnectionLike,
  TIntegration extends ProviderAccountIntegrationLike,
>(input: {
  readonly connections: readonly TConnection[];
  readonly integrationsByKind: ReadonlyMap<string, TIntegration>;
  readonly families?: ReadonlySet<string>;
}): readonly ProviderAccount<TConnection, TIntegration>[] {
  const families = input.families ?? MULTI_SERVICE_FAMILIES;
  const groups = new Map<string, ProviderAccount<TConnection, TIntegration>>();

  for (const connection of input.connections) {
    const integration = input.integrationsByKind.get(String(connection.integration));
    if (!integration) continue;

    const family = integration.kind;
    const email = normalizeEmail(connection.identityLabel);
    const canMerge = families.has(family) && email !== null;
    const identityKey = canMerge
      ? `${String(connection.owner)}:${family}:${email}`
      : singletonIdentityKey(connection, family);
    const label = canMerge ? email : displayLabelFor(connection);
    const existing = groups.get(identityKey);
    const entry = { connection, integration };

    if (existing) {
      groups.set(identityKey, {
        ...existing,
        connections: [...existing.connections, entry],
      });
      continue;
    }

    groups.set(identityKey, {
      family,
      owner: connection.owner,
      identityKey,
      label,
      connections: [entry],
    });
  }

  return Array.from(groups.values())
    .map((account) => ({
      ...account,
      connections: [...account.connections].sort((a, b) => {
        const integrationOrder = String(a.integration.slug).localeCompare(
          String(b.integration.slug),
        );
        if (integrationOrder !== 0) return integrationOrder;
        return String(a.connection.name).localeCompare(String(b.connection.name));
      }),
    }))
    .sort((a, b) => {
      const ownerOrder = String(a.owner).localeCompare(String(b.owner));
      if (ownerOrder !== 0) return ownerOrder;
      const familyOrder = a.family.localeCompare(b.family);
      if (familyOrder !== 0) return familyOrder;
      return a.identityKey.localeCompare(b.identityKey);
    });
}
