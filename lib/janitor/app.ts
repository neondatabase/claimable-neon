import { randomUUID } from "node:crypto";
import * as Sentry from "@sentry/node";
import { Hono } from "hono";

import { shouldCaptureServiceError, toServiceError } from "../errors/errors.ts";
import {
	type JanitorDependencies,
	type PurgeRunResult,
	purgeUnclaimedProjects,
} from "./purge.ts";
import { parseScheduleTrigger } from "./trigger.ts";

type Variables = { requestId: string };

export const janitorResponseStatus = (result: PurgeRunResult): 200 | 500 =>
	result.failed > 0 ? 500 : 200;

export const createJanitorApp = (dependencies: JanitorDependencies) => {
	const app = new Hono<{ Variables: Variables }>();

	app.use("*", (context, next) =>
		Sentry.withIsolationScope(() =>
			Sentry.startSpan(
				{
					op: "http.server",
					name: `${context.req.method} ${context.req.path}`,
					forceTransaction: true,
					attributes: {
						"http.request.method": context.req.method,
						"url.path": context.req.path,
					},
				},
				async (span) => {
					await next();
					span.setAttribute("http.response.status_code", context.res.status);
				},
			).finally(() => Sentry.flush(2000)),
		),
	);

	app.use("*", async (context, next) => {
		context.set("requestId", context.req.header("x-request-id") ?? randomUUID());
		try {
			await next();
		} finally {
			context.header("x-request-id", context.get("requestId"));
			await dependencies.analytics.flush();
		}
	});

	app.get("/health", (context) =>
		context.json({ status: "ok", service: "claimable-neon-janitor" }),
	);

	app.post("/", async (context) => {
		const invocationIdHeader = context.req.header("x-neon-trigger-invocation-id");
		if (!invocationIdHeader?.trim()) {
			return context.json({ error: "missing_header" }, 401);
		}
		let body: unknown;
		try {
			body = await context.req.json();
		} catch {
			return context.json({ error: "invalid_body" }, 400);
		}
		const parsed = parseScheduleTrigger({
			invocationIdHeader,
			body,
		});
		if (!parsed.ok) {
			const status = parsed.error === "invalid_body" ? 400 : 401;
			return context.json({ error: parsed.error }, status);
		}
		const result = await purgeUnclaimedProjects(dependencies, { now: new Date() });
		return context.json(
			{
				invocationId: parsed.invocationId,
				scheduledAt: parsed.scheduledAt,
				...result,
			},
			janitorResponseStatus(result),
		);
	});

	app.onError((error, context) => {
		const serviceError = toServiceError(error);
		const requestId = context.get("requestId") ?? randomUUID();
		if (shouldCaptureServiceError(serviceError)) {
			const tags: Record<string, string> = { code: serviceError.code };
			if (serviceError.options.upstreamStatus !== undefined) {
				tags.upstream_status = String(serviceError.options.upstreamStatus);
			}
			Sentry.captureException(error, { tags });
		}
		return new Response(
			JSON.stringify({
				error: serviceError.code,
				message: serviceError.message,
				request_id: requestId,
			}),
			{
				status: serviceError.status,
				headers: { "content-type": "application/json" },
			},
		);
	});

	return app;
};
