import * as Sentry from "@sentry/node";
import { describe, expect, it } from "vitest";
import { isSentryEnabled } from "../src/sentry-enabled.ts";

describe("isSentryEnabled", () => {
	it("requires exact production enablement and a DSN", () => {
		expect(
			isSentryEnabled({
				SENTRY_ENABLED: "true",
				SENTRY_DSN: "https://public@example.test/1",
			}),
		).toBe(true);
		expect(isSentryEnabled({ SENTRY_DSN: "https://public@example.test/1" })).toBe(false);
		expect(
			isSentryEnabled({
				SENTRY_ENABLED: "false",
				SENTRY_DSN: "https://public@example.test/1",
			}),
		).toBe(false);
		expect(isSentryEnabled({ SENTRY_ENABLED: "true" })).toBe(false);
	});

	it("the test launcher leaves the Sentry SDK uninitialized", async () => {
		const sigtermListeners = process.listenerCount("SIGTERM");
		expect(process.env.SENTRY_ENABLED).toBe("false");
		await import("../src/instrument.ts");
		expect(Sentry.getClient()).toBeUndefined();
		expect(process.listenerCount("SIGTERM")).toBe(sigtermListeners);
	});
});
