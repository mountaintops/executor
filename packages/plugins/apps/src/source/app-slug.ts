export const CUSTOM_TOOLS_APP_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const slugifyCustomToolsAppName = (input: string): string => {
  const base = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base.slice(0, 63).replace(/-+$/g, "");
};

export const validateCustomToolsAppSlug = (slug: string): string | null => {
  if (slug.length === 0) return "Enter a name with at least one letter or number.";
  return CUSTOM_TOOLS_APP_SLUG_PATTERN.test(slug)
    ? null
    : "Use lowercase letters, numbers, and hyphens. Start and end with a letter or number.";
};
