/**
 * Detect unsafe exposure of privileged Supabase keys via Vite public env.
 * Used by unit tests and optional runtime asserts — never logs secret values.
 */
export function findUnsafeViteEnvKeys(
  env: Record<string, string | undefined> = import.meta.env as Record<string, string | undefined>,
): string[] {
  const unsafe: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("VITE_")) continue;
    const upper = key.toUpperCase();
    if (
      upper.includes("SERVICE_ROLE") ||
      upper.includes("SECRET") ||
      upper.includes("AI_API") ||
      upper.includes("OPENAI") ||
      upper.includes("ANTHROPIC")
    ) {
      unsafe.push(key);
      continue;
    }
    if (
      typeof value === "string" &&
      (value.startsWith("sb_secret_") ||
        value.includes("service_role") ||
        value.startsWith("sk-"))
    ) {
      unsafe.push(key);
    }
  }
  return unsafe;
}

export function assertNoServiceRoleInViteEnv(
  env?: Record<string, string | undefined>,
): void {
  const bad = findUnsafeViteEnvKeys(env);
  if (bad.length > 0) {
    throw new Error(
      `Refusing to start: privileged key name/value exposed via Vite env (${bad.join(", ")}). Use server-only env without VITE_ prefix.`,
    );
  }
}
