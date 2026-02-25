const KEBAB_CASE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function toKebabCase(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function isKebabCase(value: string): boolean {
  return KEBAB_CASE_PATTERN.test(value.trim());
}

export function withCollisionSuffix(base: string, index: number): string {
  if (index <= 1) return base;
  return `${base}-${index}`;
}
