import { isIP } from "node:net";
import { z } from "zod";

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

const SPECIAL_USE_HOST_SUFFIXES = [
	".local",
	".internal",
	".localhost",
	".test",
	".invalid",
	".example",
	".onion",
	".home.arpa",
] as const;

export const dataApiSettingsBody = strict({
	db_aggregates_enabled: z.boolean().optional(),
	db_anon_role: z.literal("anonymous").optional(),
	db_extra_search_path: z.string().min(1).optional(),
	db_max_rows: z.number().int().min(1).optional(),
	db_schemas: z.array(z.string().min(1)).optional(),
	jwt_role_claim_key: z.string().min(1).optional(),
	jwt_cache_max_lifetime: z.number().int().min(0).optional(),
	openapi_mode: z.enum(["ignore-privileges", "disabled"]).optional(),
	server_cors_allowed_origins: z.string().min(1).optional(),
	server_timing_enabled: z.boolean().optional(),
});

const EXTERNAL_ONLY_KEYS = ["jwks_url", "provider_name", "jwt_audience"] as const;

/** Neon fetches this URL from its control plane, so anonymous callers cannot target local hosts. */
export const jwksUrlRefusal = (value: string): string | undefined => {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return "jwks_url must be a valid URL.";
	}
	if (url.protocol !== "https:") {
		return "jwks_url must use https.";
	}
	if (url.username !== "" || url.password !== "") {
		return "jwks_url must not include userinfo.";
	}

	let hostname = url.hostname.toLowerCase();
	if (hostname.startsWith("[") && hostname.endsWith("]")) {
		hostname = hostname.slice(1, -1);
	}
	if (hostname.endsWith(".")) {
		hostname = hostname.slice(0, -1);
	}
	if (hostname.length === 0) {
		return "jwks_url must include a hostname.";
	}
	if (isIP(hostname) !== 0) {
		return "jwks_url hostname must not be an IP address.";
	}
	if (hostname === "localhost") {
		return "jwks_url hostname must not be localhost.";
	}
	if (!hostname.includes(".")) {
		return "jwks_url hostname must be a registered name.";
	}
	for (const suffix of SPECIAL_USE_HOST_SUFFIXES) {
		if (hostname === suffix.slice(1) || hostname.endsWith(suffix)) {
			return `jwks_url hostname must not use ${suffix.slice(1)}.`;
		}
	}
	return undefined;
};

export const dataApiCreateBody = strict({
	auth_provider: z.enum(["neon_auth", "external"]).optional(),
	jwks_url: z.string().optional(),
	provider_name: z.string().min(1).optional(),
	jwt_audience: z.string().min(1).optional(),
	settings: dataApiSettingsBody.optional(),
}).superRefine((value, ctx) => {
	if (value.auth_provider === "external") {
		if (value.jwks_url === undefined) {
			ctx.addIssue({
				code: "custom",
				path: ["jwks_url"],
				message: 'jwks_url is required when auth_provider is "external".',
			});
			return;
		}
		const refusal = jwksUrlRefusal(value.jwks_url);
		if (refusal !== undefined) {
			ctx.addIssue({
				code: "custom",
				path: ["jwks_url"],
				message: refusal,
			});
		}
		return;
	}
	for (const key of EXTERNAL_ONLY_KEYS) {
		if (value[key] !== undefined) {
			ctx.addIssue({
				code: "custom",
				path: [key],
				message: `${key} is only allowed with auth_provider: "external".`,
			});
		}
	}
});

export type DataApiCreateBody = z.infer<typeof dataApiCreateBody>;

export const dataApiUpdateBody = strict({
	settings: dataApiSettingsBody.optional(),
});

export const dataApiCreateBodyForProvisioning = (
	authGranted: boolean,
	requested: DataApiCreateBody | undefined,
): DataApiCreateBody => {
	if (requested !== undefined) return requested;
	return authGranted ? { auth_provider: "neon_auth" } : {};
};

export const dataApiCreateRequestsNeonAuth = (body: DataApiCreateBody): boolean =>
	body.auth_provider === "neon_auth";
