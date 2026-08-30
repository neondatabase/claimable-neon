import * as Sentry from "@sentry/node";

const dsn = process.env.SENTRY_DSN;
const release = process.env.SENTRY_RELEASE;

Sentry.init({
	...(dsn ? { dsn } : {}),
	enabled: Boolean(dsn),
	enableLogs: true,
	tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 1),
	traceLifecycle: "stream",
	streamGenAiSpans: true,
	integrations: [
		Sentry.vercelAIIntegration({ force: true }),
		Sentry.httpIntegration({ disableIncomingRequestSpans: true }),
	],
	...(release ? { release } : {}),
	environment:
		process.env.SENTRY_ENVIRONMENT ??
		(process.env.NEON_BRANCH &&
		process.env.NEON_BRANCH !== (process.env.PRODUCTION_BRANCH ?? "main")
			? process.env.NEON_BRANCH
			: "production"),
});

process.on("SIGTERM", () => void Sentry.flush(2000));
process.on("SIGINT", () => void Sentry.flush(2000));

export { Sentry };
