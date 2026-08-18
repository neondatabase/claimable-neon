import { describe, expect, it } from "vitest";

import {
	PROXY_SECRET_HEADER,
	requireProxySharedSecret,
	secretsMatch,
} from "../lib/edge/secret.ts";
import { ServiceError } from "../lib/errors/errors.ts";

describe("proxy shared secret", () => {
	it("accepts an exact match", () => {
		expect(secretsMatch("shared-secret", "shared-secret")).toBe(true);
	});

	it("rejects a missing, short, or wrong value without throwing on length", () => {
		expect(secretsMatch("shared-secret", undefined)).toBe(false);
		expect(secretsMatch("shared-secret", "nope")).toBe(false);
		expect(secretsMatch("shared-secret", "shared-secre")).toBe(false);
	});

	it("skips the gate when the process has no required secret", () => {
		expect(() => requireProxySharedSecret(undefined, "")).not.toThrow();
		expect(() => requireProxySharedSecret("anything", "")).not.toThrow();
	});

	it("refuses a missing or wrong header when a secret is required", () => {
		expect(() => requireProxySharedSecret(undefined, "shared-secret")).toThrow(
			ServiceError,
		);
		expect(() => requireProxySharedSecret("wrong-secret", "shared-secret")).toThrow(
			ServiceError,
		);
		try {
			requireProxySharedSecret("wrong-secret", "shared-secret");
		} catch (error) {
			expect(error).toBeInstanceOf(ServiceError);
			if (error instanceof ServiceError) {
				expect(error.code).toBe("unauthorized");
				expect(error.status).toBe(401);
			}
		}
	});

	it("uses the forwarding header name the Function gate reads", () => {
		expect(PROXY_SECRET_HEADER).toBe("x-claimable-proxy-secret");
	});
});
