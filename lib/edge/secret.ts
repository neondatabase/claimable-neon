import { timingSafeEqual } from "node:crypto";

import { ServiceError } from "../errors/errors.ts";

export const PROXY_SECRET_HEADER = "x-claimable-proxy-secret";

export const secretsMatch = (expected: string, provided: string | undefined): boolean => {
	const left = Buffer.from(expected, "utf8");
	const right = Buffer.from(provided ?? "", "utf8");
	if (left.length !== right.length) {
		return false;
	}
	return timingSafeEqual(left, right);
};

export const requireProxySharedSecret = (
	provided: string | undefined,
	required: string,
): void => {
	if (required.length === 0) {
		return;
	}
	if (!secretsMatch(required, provided)) {
		throw new ServiceError("unauthorized", "Unauthorized.");
	}
};
