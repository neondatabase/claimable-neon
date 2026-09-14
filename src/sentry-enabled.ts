export function isSentryEnabled(env: Record<string, string | undefined>): boolean {
	return env.SENTRY_ENABLED === "true" && Boolean(env.SENTRY_DSN?.trim());
}
