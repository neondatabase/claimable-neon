import { randomUUID } from "node:crypto";
import * as Sentry from "@sentry/node";
import { Hono } from "hono";
import { z } from "zod";

import type { Analytics } from "../analytics/analytics.ts";
import {
	REQUIRES_CLAIM,
	decideCapabilities,
	grantedCapabilities,
} from "../capabilities/capabilities.ts";
import {
	hasScope,
	scopesForCapabilities,
	withGrantableConfigureScopes,
	withGrantedCapability,
	withoutDataApiQuery,
} from "../capabilities/scopes.ts";
import { generateClaimCode, hashClaimCode, normalizeClaimCode } from "../claims/codes.ts";
import { claimCodeIssuance } from "../claims/issuance.ts";
import { missingClaimableProjectError } from "../claims/missing-project.ts";
import { prepareClaimTransfer, reconcileAcceptedClaim } from "../claims/reconcile.ts";
import { type Config, tokenVerifyExpected } from "../config/config.ts";
import { decryptProjectKey, encryptProjectKey } from "../crypto/project-keys.ts";
import {
	authMarkdown,
	authorizationServerMetadata,
	llmsTxt,
	protectedResourceMetadata,
} from "../discovery/discovery.ts";
import { PROXY_SECRET_HEADER, requireProxySharedSecret } from "../edge/secret.ts";
import {
	ServiceError,
	isServiceError,
	shouldCaptureServiceError,
	toServiceError,
} from "../errors/errors.ts";
import { NeonClient, type NeonResponse } from "../neon/client.ts";
import {
	configureCapabilities,
	createClaimableProject,
	createProjectTransferRequest,
	deleteClaimableProject,
	getProjectOwnerOrg,
	mintProjectKey,
	parseAuthServiceCredential,
	parseAuthServiceCredentialPublic,
	parseDataApiServiceCredential,
	revokeProjectKey,
} from "../neon/provisioning.ts";
import {
	type MatchedOperation,
	type Operation,
	matchOperation,
	projectResponse,
	shouldRelayUpstreamStatus,
} from "../proxy/allowlist.ts";
import {
	dataApiCreateBody,
	dataApiCreateRequestsNeonAuth,
} from "../proxy/data-api-body.ts";
import {
	type ClaimAttempt,
	type Registration,
	type Sql,
	type UsageEventName,
	createClaimAttempt,
	createRegistration,
	deleteRegistration,
	deleteServiceCredential,
	findPendingClaimByCode,
	findRegistration,
	freezeIssuance,
	getProjectKey,
	getServiceCredentials,
	isTokenRevoked,
	latestClaimAttempt,
	markProjectKeyRevoked,
	recordCapabilityRequests,
	recordDerivedCredential,
	recordToken,
	recordUsageEvent,
	requireUsableRegistration,
	revokeAllTokens,
	revokeRegistration,
	revokeToken,
	setClaimAttemptState,
	setClaimState,
	startClaimTransfer,
	storeProjectKey,
	storeServiceCredential,
	updateRegistrationScopes,
	withRegistrationLock,
} from "../store/store.ts";
import { publicJwks } from "../tokens/keys.ts";
import {
	type SigningKey,
	mintAccessToken,
	mintAssertion,
	verifyAccessToken,
	verifyAssertion,
} from "../tokens/tokens.ts";

const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";

const identityRequest = z
	.object({
		type: z.literal("anonymous"),
		capabilities: z.array(z.string().min(1)).max(20).default([]),
		source: z.string().min(1).max(100).default("raw_api"),
		data_api: dataApiCreateBody.optional(),
	})
	.strict();

const dataApiBodyForIdentity = (
	request: z.infer<typeof identityRequest>,
	capabilities: ReturnType<typeof grantedCapabilities>,
): z.infer<typeof dataApiCreateBody> | undefined => {
	if (request.data_api === undefined) return undefined;
	if (!capabilities.includes("data_api")) {
		throw new ServiceError(
			"invalid_request",
			"data_api configuration requires the data_api capability.",
		);
	}
	return request.data_api;
};

const tokenRequest = z.object({
	grant_type: z.literal(JWT_BEARER_GRANT),
	assertion: z.string().min(1),
	resource: z.string().url().optional(),
});

const revokeRequest = z.object({
	token: z.string().min(1),
	token_type_hint: z.enum(["access_token", "identity_assertion"]).optional(),
});

const claimTokenRequest = z
	.object({
		claim_token: z.string().min(1),
	})
	.strict();

const claimCodeRequest = z.object({
	user_code: z.string().min(1),
});

const connectionUriResponse = z.object({
	uri: z.string().min(1),
});

export type AppDependencies = {
	config: Config;
	sql: Sql;
	signingKey: SigningKey;
	orgClient: NeonClient;
	personalClient: NeonClient;
	analytics: Analytics;
};

const emitUsage = async (
	dependencies: AppDependencies,
	event: UsageEventName,
	fields: {
		source?: string;
		registrationId?: string;
		projectId?: string;
		method?: string;
		pattern?: string;
		identityType?: string;
		reason?: string;
		claimState?: string;
	},
): Promise<void> => {
	const properties: Record<string, string> = {};
	if (fields.source !== undefined) properties.source = fields.source;
	if (fields.method !== undefined) properties.method = fields.method;
	if (fields.pattern !== undefined) properties.pattern = fields.pattern;
	if (fields.identityType !== undefined) properties.identity_type = fields.identityType;
	if (fields.reason !== undefined) properties.reason = fields.reason;
	if (fields.claimState !== undefined) properties.claim_state = fields.claimState;
	await recordUsageEvent(dependencies.sql, {
		event,
		source: fields.source,
		registrationId: fields.registrationId,
		projectId: fields.projectId,
		properties,
	});
	const trackProperties: Record<string, string> = { ...properties };
	if (fields.registrationId !== undefined) {
		trackProperties.registration_id = fields.registrationId;
	}
	if (fields.projectId !== undefined) {
		trackProperties.project_id = fields.projectId;
	}
	dependencies.analytics.track(event, trackProperties);
};

const beginClaimTransfer = async (
	dependencies: AppDependencies,
	registration: Registration,
	attempt: ClaimAttempt,
): Promise<{ transferRequestId: string; prepared: boolean }> => {
	try {
		// Overlapping role resets fail the snapshot check and leave compute disabled.
		if (attempt.transferRequestId) {
			return { transferRequestId: attempt.transferRequestId, prepared: false };
		}
		await freezeIssuance(dependencies.sql, registration.id);
		await setClaimState(dependencies.sql, registration.id, "pending");
		await prepareClaimTransfer(dependencies, registration);
		const transfer = await createProjectTransferRequest(
			dependencies.orgClient,
			registration.neonProjectId,
			dependencies.config.claimAttemptTtlSeconds,
		);
		await startClaimTransfer(dependencies.sql, {
			attemptId: attempt.id,
			transferRequestId: transfer.id,
			expiresAt: transfer.expiresAt,
		});
		return { transferRequestId: transfer.id, prepared: true };
	} catch (error) {
		const mapped = missingClaimableProjectError(error, registration);
		if (!mapped) throw error;
		await emitUsage(dependencies, "claim_missing_project", {
			source: registration.source,
			registrationId: registration.id,
			projectId: registration.neonProjectId,
			reason: mapped.code === "project_claimed" ? "already_claimed" : "deleted",
			claimState: registration.claimState,
		});
		throw mapped;
	}
};

type Variables = {
	requestId: string;
};

const parseJsonBody = async (request: Request): Promise<unknown> => {
	try {
		return await request.json();
	} catch (cause) {
		throw new ServiceError("invalid_request", "Request body must be valid JSON.", {
			cause,
		});
	}
};

const parseFormBody = async (request: Request): Promise<Record<string, string>> => {
	const parameters = new URLSearchParams(await request.text());
	return Object.fromEntries(parameters.entries());
};

const parseWith = <Schema extends z.ZodTypeAny>(
	schema: Schema,
	value: unknown,
	message: string,
): z.output<Schema> => {
	const parsed = schema.safeParse(value);
	if (!parsed.success) {
		throw new ServiceError("invalid_request", message, {
			details: parsed.error.flatten(),
		});
	}
	return parsed.data;
};

const errorResponse = (
	error: ServiceError,
	requestId: string,
	publicOrigin: string,
): Response =>
	new Response(JSON.stringify(error.toBody(requestId)), {
		status: error.status,
		headers: {
			"content-type": "application/json",
			"x-request-id": requestId,
			...(error.status === 401
				? {
						"www-authenticate": `Bearer resource_metadata="${publicOrigin}/.well-known/oauth-protected-resource"`,
					}
				: {}),
		},
	});

const escapeHtml = (value: string): string =>
	value.replace(/[&<>"']/g, (character) => {
		const entities: Record<string, string> = {
			"&": "&amp;",
			"<": "&lt;",
			">": "&gt;",
			'"': "&quot;",
			"'": "&#39;",
		};
		return entities[character] ?? "";
	});

const claimErrorResponse = (error: ServiceError, requestId: string): Response =>
	new Response(
		`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Claim could not continue</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { display: grid; min-height: 100vh; margin: 0; place-items: center; }
    main { width: min(28rem, calc(100% - 2rem)); }
    a { color: #00e599; }
    code { font-size: .85em; }
  </style>
</head>
<body>
  <main>
    <h1>Claim could not continue</h1>
    <p>${escapeHtml(error.message)}</p>
    <p><a href="/claim">Enter another claim code</a></p>
    <p><small>Request ID: <code>${escapeHtml(requestId)}</code></small></p>
  </main>
</body>
</html>`,
		{
			status: error.status,
			headers: {
				"content-type": "text/html; charset=UTF-8",
				"x-request-id": requestId,
			},
		},
	);

const bearerToken = (authorization: string | undefined): string => {
	if (!authorization?.startsWith("Bearer ")) {
		throw new ServiceError(
			"unauthorized",
			"Present an access token as `Authorization: Bearer <token>`.",
		);
	}
	const token = authorization.slice("Bearer ".length).trim();
	if (token.length === 0) {
		throw new ServiceError("unauthorized", "Bearer token is empty.");
	}
	return token;
};

const isUnverifiableRevocationToken = (error: unknown): boolean =>
	isServiceError(error) &&
	(error.code === "unauthorized" ||
		error.code === "token_expired" ||
		error.code === "invalid_grant");

const revocationJti = async (
	dependencies: AppDependencies,
	token: string,
): Promise<string | null> => {
	try {
		const claims = await verifyAccessToken(
			dependencies.signingKey,
			token,
			tokenVerifyExpected(dependencies.config),
		);
		return claims.jti;
	} catch (error) {
		if (!isUnverifiableRevocationToken(error)) throw error;
	}

	try {
		const claims = await verifyAssertion(
			dependencies.signingKey,
			token,
			tokenVerifyExpected(dependencies.config),
		);
		return claims.jti;
	} catch (error) {
		if (!isUnverifiableRevocationToken(error)) throw error;
		return null;
	}
};

type AuthenticatedRegistration = {
	registration: Registration;
	tokenScopes: Registration["scopes"];
};

const authenticate = async (
	authorization: string | undefined,
	dependencies: AppDependencies,
): Promise<AuthenticatedRegistration> => {
	const token = bearerToken(authorization);
	const claims = await verifyAccessToken(
		dependencies.signingKey,
		token,
		tokenVerifyExpected(dependencies.config),
	);
	if (await isTokenRevoked(dependencies.sql, claims.jti)) {
		throw new ServiceError("unauthorized", "This access token was revoked.");
	}
	const registration = await requireUsableRegistration(
		dependencies.sql,
		claims.registration_id,
	);
	if (registration.neonProjectId !== claims.project_id) {
		throw new ServiceError(
			"unauthorized",
			"Access token project does not match its registration.",
		);
	}
	if (registration.issuanceFrozen) {
		throw new ServiceError(
			"claim_in_progress",
			"This project is being claimed. Only claim-status polling is available.",
			{ claimState: registration.claimState },
		);
	}
	return { registration, tokenScopes: claims.scopes };
};

const authenticateClaimCode = async (
	authorization: string | undefined,
	dependencies: AppDependencies,
): Promise<AuthenticatedRegistration> => {
	const token = bearerToken(authorization);
	const claims = await verifyAccessToken(
		dependencies.signingKey,
		token,
		tokenVerifyExpected(dependencies.config),
	);
	if (await isTokenRevoked(dependencies.sql, claims.jti)) {
		throw new ServiceError("unauthorized", "This access token was revoked.");
	}
	const registration = await requireUsableRegistration(
		dependencies.sql,
		claims.registration_id,
	);
	if (registration.neonProjectId !== claims.project_id) {
		throw new ServiceError(
			"unauthorized",
			"Access token project does not match its registration.",
		);
	}
	return { registration, tokenScopes: claims.scopes };
};

const authenticateClaimStatus = async (
	authorization: string | undefined,
	dependencies: AppDependencies,
): Promise<AuthenticatedRegistration> => {
	const token = bearerToken(authorization);
	const claims = await verifyAccessToken(
		dependencies.signingKey,
		token,
		tokenVerifyExpected(dependencies.config),
	);
	const registration = await findRegistration(dependencies.sql, claims.registration_id);
	if (!registration) {
		throw new ServiceError("unauthorized", "Access token registration does not exist.");
	}
	if (registration.neonProjectId !== claims.project_id) {
		throw new ServiceError(
			"unauthorized",
			"Access token project does not match its registration.",
		);
	}
	// A reconciled claim is terminal and non-sensitive. Let a previously issued token repeat this
	// one read even though reconciliation revoked it, so a lost final response is recoverable.
	if (registration.claimState === "reconciled") {
		return { registration, tokenScopes: [] };
	}
	if (await isTokenRevoked(dependencies.sql, claims.jti)) {
		throw new ServiceError("unauthorized", "This access token was revoked.");
	}
	const usable = await requireUsableRegistration(dependencies.sql, registration.id);
	return { registration: usable, tokenScopes: claims.scopes };
};

const withAuthenticatedRegistrationLock = async <Result>(
	authorization: string | undefined,
	dependencies: AppDependencies,
	operation: (
		authenticated: AuthenticatedRegistration,
		lockedDependencies: AppDependencies,
	) => Promise<Result>,
): Promise<Result> => {
	const initial = await authenticate(authorization, dependencies);
	return withRegistrationLock(
		dependencies.sql,
		initial.registration.id,
		async (lockedSql) => {
			const lockedDependencies = { ...dependencies, sql: lockedSql };
			return operation(
				await authenticate(authorization, lockedDependencies),
				lockedDependencies,
			);
		},
	);
};

const withClaimCodeLock = async <Result>(
	authorization: string | undefined,
	dependencies: AppDependencies,
	operation: (
		authenticated: AuthenticatedRegistration,
		lockedDependencies: AppDependencies,
	) => Promise<Result>,
): Promise<Result> => {
	const initial = await authenticateClaimCode(authorization, dependencies);
	return withRegistrationLock(
		dependencies.sql,
		initial.registration.id,
		async (lockedSql) => {
			const lockedDependencies = { ...dependencies, sql: lockedSql };
			return operation(
				await authenticateClaimCode(authorization, lockedDependencies),
				lockedDependencies,
			);
		},
	);
};

const withClaimStatusLock = async <Result>(
	authorization: string | undefined,
	dependencies: AppDependencies,
	operation: (
		authenticated: AuthenticatedRegistration,
		lockedDependencies: AppDependencies,
	) => Promise<Result>,
): Promise<Result> => {
	const initial = await authenticateClaimStatus(authorization, dependencies);
	return withRegistrationLock(
		dependencies.sql,
		initial.registration.id,
		async (lockedSql) => {
			const lockedDependencies = { ...dependencies, sql: lockedSql };
			return operation(
				await authenticateClaimStatus(authorization, lockedDependencies),
				lockedDependencies,
			);
		},
	);
};

const requireMatchingProject = (registration: Registration, projectId: string): void => {
	if (registration.neonProjectId !== projectId) {
		throw new ServiceError(
			"route_not_allowed",
			"An agent token can act only on its own project.",
		);
	}
};

const projectClient = async (
	dependencies: AppDependencies,
	registration: Registration,
): Promise<NeonClient> => {
	const stored = await getProjectKey(dependencies.sql, registration.id);
	if (stored.revokedAt) {
		throw new ServiceError("project_claimed", "The project credential was revoked.");
	}
	const apiKey = decryptProjectKey(stored, dependencies.config.keyEncryptionKey);
	return new NeonClient({
		apiKey,
		baseUrl: dependencies.config.neonApiHost,
	});
};

const cleanupProvisioning = async (
	dependencies: AppDependencies,
	input: {
		registrationId: string;
		projectId?: string;
		keyId?: number;
		original: unknown;
	},
): Promise<never> => {
	const cleanupFailures: string[] = [];
	try {
		await deleteRegistration(dependencies.sql, input.registrationId);
	} catch (error) {
		cleanupFailures.push(`registration: ${toServiceError(error).message}`);
	}
	if (input.keyId !== undefined) {
		try {
			await revokeProjectKey(
				dependencies.orgClient,
				dependencies.config.neonOrgId,
				input.keyId,
			);
		} catch (error) {
			cleanupFailures.push(`project key: ${toServiceError(error).message}`);
		}
	}
	if (input.projectId !== undefined) {
		try {
			await deleteClaimableProject(dependencies.orgClient, input.projectId);
		} catch (error) {
			cleanupFailures.push(`project: ${toServiceError(error).message}`);
		}
	}
	if (cleanupFailures.length > 0) {
		throw new ServiceError(
			"internal_error",
			"Provisioning failed and cleanup was incomplete.",
			{
				cause: input.original,
				details: { cleanup_failures: cleanupFailures },
			},
		);
	}
	throw toServiceError(input.original);
};

const decodeServiceCredential = (
	ciphertext: Buffer,
	nonce: Buffer,
	key: Buffer,
): unknown => {
	const value = decryptProjectKey({ ciphertext, nonce }, key);
	try {
		return JSON.parse(value);
	} catch (cause) {
		throw new ServiceError(
			"internal_error",
			"Stored service credential is not valid JSON.",
			{ cause },
		);
	}
};

const createClaimCode = async (
	dependencies: AppDependencies,
	registration: Registration,
) => {
	const previous = await latestClaimAttempt(dependencies.sql, registration.id);
	const decision = claimCodeIssuance({
		issuanceFrozen: registration.issuanceFrozen,
		registrationClaimState: registration.claimState,
		latest: previous,
		now: new Date(),
	});
	if (decision.action === "refuse") {
		throw new ServiceError(
			decision.error,
			decision.error === "project_claimed"
				? "This project has been claimed. Use your own Neon credentials — run `neon auth`."
				: "A claim ceremony is already in progress for this project.",
			{ claimState: registration.claimState },
		);
	}
	if (registration.issuanceFrozen) {
		const ownerOrg = await getProjectOwnerOrg(
			dependencies.orgClient,
			registration.neonProjectId,
		);
		if (ownerOrg !== dependencies.config.neonOrgId) {
			throw new ServiceError(
				"project_claimed",
				"This project has been claimed. Use your own Neon credentials — run `neon auth`.",
				{ claimState: registration.claimState },
			);
		}
	}
	if (decision.expireAttemptId !== null) {
		await setClaimAttemptState(dependencies.sql, {
			attemptId: decision.expireAttemptId,
			state: "expired",
		});
	}
	if (decision.cancelAttemptId !== null) {
		await setClaimAttemptState(dependencies.sql, {
			attemptId: decision.cancelAttemptId,
			state: "cancelled",
		});
	}
	const code = generateClaimCode();
	const expiresAt = new Date(
		Date.now() + dependencies.config.claimAttemptTtlSeconds * 1000,
	);
	await createClaimAttempt(dependencies.sql, {
		registrationId: registration.id,
		userCodeHash: hashClaimCode(code),
		expiresAt,
	});
	const verificationUri = `${dependencies.config.publicOrigin}/claim`;
	return {
		user_code: code,
		verification_uri: verificationUri,
		verification_uri_complete: `${verificationUri}?user_code=${encodeURIComponent(code)}`,
		expires_in: dependencies.config.claimAttemptTtlSeconds,
		interval: 5,
	};
};

const getClaimStatus = async (
	dependencies: AppDependencies,
	registration: Registration,
) => {
	const attempt = await latestClaimAttempt(dependencies.sql, registration.id);
	if (!attempt) {
		throw new ServiceError("not_found", "No claim attempt exists for this project.");
	}
	let state = attempt.state;
	let claimedIntoOrg = registration.claimedIntoOrg;
	if (state === "pending" && attempt.expiresAt.getTime() <= Date.now()) {
		await setClaimAttemptState(dependencies.sql, {
			attemptId: attempt.id,
			state: "expired",
		});
		state = "expired";
	}
	if (state === "pending" && attempt.transferRequestId) {
		const ownerOrg = await getProjectOwnerOrg(
			dependencies.orgClient,
			registration.neonProjectId,
		);
		if (ownerOrg !== dependencies.config.neonOrgId) {
			claimedIntoOrg = ownerOrg;
			await setClaimAttemptState(dependencies.sql, {
				attemptId: attempt.id,
				state: "accepted",
			});
			await setClaimState(dependencies.sql, registration.id, "accepted", {
				...(ownerOrg ? { claimedIntoOrg: ownerOrg } : {}),
			});
			state = "accepted";
		}
	}
	if (state === "accepted") {
		await reconcileAcceptedClaim(dependencies, registration, attempt, claimedIntoOrg);
		state = "reconciled";
		await emitUsage(dependencies, "claim_reconciled", {
			source: registration.source,
			registrationId: registration.id,
			projectId: registration.neonProjectId,
		});
	}
	return {
		state,
		expires_at: attempt.expiresAt.toISOString(),
		reconciled: state === "reconciled",
	};
};

const authorizeProxyOperation = (
	operation: Operation,
	authenticated: {
		registration: Registration;
		tokenScopes: Registration["scopes"];
	},
): void => {
	if (operation.capability && REQUIRES_CLAIM.includes(operation.capability)) {
		throw new ServiceError(
			"capability_requires_claim",
			`${operation.capability} requires a claimed project.`,
			{ claimState: authenticated.registration.claimState },
		);
	}
	if (operation.scope && !hasScope(authenticated.tokenScopes, operation.scope)) {
		throw new ServiceError(
			"scope_insufficient",
			`This operation requires ${operation.scope}.`,
			{ requiredScope: operation.scope },
		);
	}
};

const proxyRequestBody = async (
	request: Request,
	operation: Operation,
): Promise<unknown> => {
	const rawBody =
		request.method === "GET" || request.method === "DELETE" ? "" : await request.text();
	let body: unknown;
	if (rawBody.length > 0) {
		try {
			body = JSON.parse(rawBody);
		} catch (cause) {
			throw new ServiceError(
				"invalid_request",
				"Proxy request body must be valid JSON.",
				{
					cause,
				},
			);
		}
	}
	if (!operation.body) {
		if (body !== undefined) {
			throw new ServiceError(
				"invalid_request",
				"This operation does not accept a request body.",
			);
		}
		return undefined;
	}
	const parsed = operation.body.safeParse(body);
	if (!parsed.success) {
		throw new ServiceError(
			"invalid_request",
			"Proxy request body contains unsupported fields or values.",
			{ details: parsed.error.flatten() },
		);
	}
	return parsed.data;
};

const relayedUpstreamResponse = (error: ServiceError): Response => {
	const status = error.options.upstreamStatus;
	if (status === undefined) throw error;
	const data = error.options.details;
	return new Response(data === undefined ? null : JSON.stringify(data), {
		status,
		headers: {
			"content-type": "application/json",
			...(error.options.upstreamRequestId
				? { "x-upstream-request-id": error.options.upstreamRequestId }
				: {}),
		},
	});
};

const requestProxiedOperation = async (
	client: NeonClient,
	dependencies: AppDependencies,
	registration: Registration,
	matched: MatchedOperation,
	method: string,
	path: string,
	body: unknown,
): Promise<NeonResponse | Response> => {
	try {
		const response = await client.request(method, path, body);
		if (response.status >= 200 && response.status < 300) {
			await persistEnabledService(
				dependencies,
				registration,
				matched,
				client,
				response.data,
				body,
			);
			await persistDisabledDataApi(dependencies, registration, matched);
		}
		return response;
	} catch (error) {
		if (
			isServiceError(error) &&
			error.code === "upstream_error" &&
			error.options.upstreamStatus !== undefined &&
			shouldRelayUpstreamStatus(matched.operation, error.options.upstreamStatus)
		) {
			if (error.options.upstreamStatus === 409) {
				await persistEnabledService(
					dependencies,
					registration,
					matched,
					client,
					undefined,
					body,
				);
			}
			if (error.options.upstreamStatus === 404) {
				await persistDisabledDataApi(dependencies, registration, matched);
			}
			return relayedUpstreamResponse(error);
		}
		throw error;
	}
};

const persistServiceCredential = async (
	dependencies: AppDependencies,
	registration: Registration,
	capability: "auth" | "data_api",
	credential: unknown,
	scopes: Registration["scopes"],
): Promise<Registration["scopes"]> => {
	const encrypted = encryptProjectKey(
		JSON.stringify(credential),
		dependencies.config.keyEncryptionKey,
	);
	await storeServiceCredential(dependencies.sql, {
		registrationId: registration.id,
		capability,
		...encrypted,
	});
	const next = withGrantedCapability(scopes, capability);
	await updateRegistrationScopes(dependencies.sql, registration.id, next);
	return next;
};

const persistAuthFromExisting = async (
	dependencies: AppDependencies,
	registration: Registration,
	client: NeonClient,
	scopes: Registration["scopes"],
): Promise<Registration["scopes"]> => {
	const projectPath = `/projects/${encodeURIComponent(registration.neonProjectId)}/branches/${encodeURIComponent(registration.neonBranchId)}`;
	const existing = await client.get(`${projectPath}/auth`);
	return persistServiceCredential(
		dependencies,
		registration,
		"auth",
		parseAuthServiceCredentialPublic(existing.data),
		scopes,
	);
};

const persistEnabledDataApi = async (
	dependencies: AppDependencies,
	registration: Registration,
	matched: MatchedOperation,
	client: NeonClient,
	data: unknown,
	body: unknown,
	stored: Awaited<ReturnType<typeof getServiceCredentials>>,
): Promise<void> => {
	const has = (value: "auth" | "data_api") =>
		stored.some((row) => row.capability === value);
	let scopes = registration.scopes;
	if (data !== undefined) {
		scopes = await persistServiceCredential(
			dependencies,
			registration,
			"data_api",
			parseDataApiServiceCredential(data),
			scopes,
		);
	} else if (!has("data_api")) {
		const databaseName = matched.params.databaseName;
		if (!databaseName) {
			throw new ServiceError(
				"internal_error",
				"Data API enable did not identify a database.",
			);
		}
		const projectPath = `/projects/${encodeURIComponent(registration.neonProjectId)}/branches/${encodeURIComponent(registration.neonBranchId)}`;
		const existing = await client.get(
			`${projectPath}/data-api/${encodeURIComponent(databaseName)}`,
		);
		scopes = await persistServiceCredential(
			dependencies,
			registration,
			"data_api",
			parseDataApiServiceCredential(existing.data),
			scopes,
		);
	}
	// The CLI may only GET the Auth service created as a Data API side effect.
	const parsedBody = dataApiCreateBody.safeParse(body);
	if (
		parsedBody.success &&
		dataApiCreateRequestsNeonAuth(parsedBody.data) &&
		!has("auth")
	) {
		await persistAuthFromExisting(dependencies, registration, client, scopes);
	}
};

const persistDisabledDataApi = async (
	dependencies: AppDependencies,
	registration: Registration,
	matched: MatchedOperation,
): Promise<void> => {
	if (matched.operation.method !== "DELETE") return;
	if (matched.operation.capability !== "data_api") return;
	if (
		matched.params.branchId !== registration.neonBranchId ||
		matched.params.databaseName !== registration.databaseName
	) {
		return;
	}
	await deleteServiceCredential(dependencies.sql, registration.id, "data_api");
	await updateRegistrationScopes(
		dependencies.sql,
		registration.id,
		withoutDataApiQuery(registration.scopes),
	);
};

const persistEnabledService = async (
	dependencies: AppDependencies,
	registration: Registration,
	matched: MatchedOperation,
	client: NeonClient,
	data: unknown,
	body: unknown,
): Promise<void> => {
	const capability = matched.operation.capability;
	if (capability !== "auth" && capability !== "data_api") return;
	if (matched.operation.method !== "POST") return;

	const stored = await getServiceCredentials(dependencies.sql, registration.id);
	if (capability === "data_api") {
		await persistEnabledDataApi(
			dependencies,
			registration,
			matched,
			client,
			data,
			body,
			stored,
		);
		return;
	}

	if (data !== undefined) {
		await persistServiceCredential(
			dependencies,
			registration,
			"auth",
			parseAuthServiceCredential(data),
			registration.scopes,
		);
		return;
	}
	// Preserve create-time credentials because GET /auth omits private fields.
	if (stored.some((row) => row.capability === "auth")) return;
	await persistAuthFromExisting(dependencies, registration, client, registration.scopes);
};

const proxyManagementRequest = async (
	request: Request,
	dependencies: AppDependencies,
	authenticated: {
		registration: Registration;
		tokenScopes: Registration["scopes"];
	},
): Promise<Response> => {
	const url = new URL(request.url);
	const apiPath = url.pathname.slice("/v1".length);
	const matched = matchOperation(request.method, apiPath);
	if (!matched) {
		throw new ServiceError(
			"route_not_allowed",
			"This Neon Management API operation is not available before claim.",
		);
	}
	const projectId = matched.params.projectId;
	if (!projectId) {
		throw new ServiceError(
			"route_not_allowed",
			"Allowed operation did not identify a project.",
		);
	}
	requireMatchingProject(authenticated.registration, projectId);
	authorizeProxyOperation(matched.operation, authenticated);
	const body = await proxyRequestBody(request, matched.operation);
	const client = await projectClient(dependencies, authenticated.registration);
	const response = await requestProxiedOperation(
		client,
		dependencies,
		authenticated.registration,
		matched,
		request.method,
		`${apiPath}${url.search}`,
		body,
	);
	if (response instanceof Response) return response;
	if (matched.operation.derivedCredential === "role_password") {
		await recordDerivedCredential(dependencies.sql, {
			registrationId: authenticated.registration.id,
			kind: "role_password",
			externalId: matched.params.roleName,
			branchId: matched.params.branchId,
			scopes: ["postgres.read", "postgres.write"],
			expiresAt: authenticated.registration.expiresAt,
		});
	}
	const data = matched.operation.project
		? projectResponse(response.data, matched.operation.project)
		: response.data;
	await emitUsage(dependencies, "proxy_call", {
		source: authenticated.registration.source,
		registrationId: authenticated.registration.id,
		projectId: authenticated.registration.neonProjectId,
		method: request.method,
		pattern: matched.operation.pattern,
	});
	return new Response(response.status === 204 ? null : JSON.stringify(data), {
		status: response.status,
		headers: {
			...(response.status === 204 ? {} : { "content-type": "application/json" }),
			...(response.requestId ? { "x-upstream-request-id": response.requestId } : {}),
		},
	});
};

export const createApp = (dependencies: AppDependencies) => {
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
			requireProxySharedSecret(
				context.req.header(PROXY_SECRET_HEADER),
				dependencies.config.proxySharedSecret,
			);
			await next();
		} finally {
			context.header("x-request-id", context.get("requestId"));
			await dependencies.analytics.flush();
		}
	});

	app.get("/health", (context) =>
		context.json({ status: "ok", service: "claimable-neon" }),
	);
	app.get("/llms.txt", (context) =>
		context.text(
			llmsTxt({
				resourceOrigin: dependencies.config.publicOrigin,
				issuer: dependencies.config.issuer,
			}),
		),
	);
	app.get("/auth.md", (context) => {
		if (dependencies.config.discoveryRedirects) {
			return context.redirect(dependencies.config.skillUrl, 301);
		}
		return context.text(authMarkdown(dependencies.config.publicOrigin));
	});
	app.get("/.well-known/oauth-protected-resource", (context) =>
		context.json(
			protectedResourceMetadata({
				resourceOrigin: dependencies.config.publicOrigin,
				issuer: dependencies.config.issuer,
			}),
		),
	);
	app.get("/.well-known/oauth-authorization-server", (context) => {
		if (dependencies.config.discoveryRedirects) {
			return context.redirect(dependencies.config.authorizationServerMetadataUrl, 301);
		}
		return context.json(
			authorizationServerMetadata({
				resourceOrigin: dependencies.config.publicOrigin,
				issuer: dependencies.config.issuer,
			}),
		);
	});
	app.get("/.well-known/jwks.json", (context) =>
		context.json(publicJwks([dependencies.signingKey])),
	);

	app.post("/v1/agent/identity", async (context) => {
		const request = parseWith(
			identityRequest,
			await parseJsonBody(context.req.raw),
			"Anonymous registration request is not valid.",
		);
		const decisions = decideCapabilities(request.capabilities);
		const capabilities = grantedCapabilities(decisions);
		const dataApiBody = dataApiBodyForIdentity(request, capabilities);
		const scopes = withGrantableConfigureScopes(scopesForCapabilities(capabilities));
		const registrationId = `reg_${randomUUID()}`;
		const expiresAt = new Date(Date.now() + dependencies.config.projectTtlSeconds * 1000);
		let projectId: string | undefined;
		let keyId: number | undefined;

		try {
			const project = await createClaimableProject(
				dependencies.orgClient,
				dependencies.config,
			);
			projectId = project.projectId;
			const mintedKey = await mintProjectKey(
				dependencies.personalClient,
				dependencies.config,
				project.projectId,
			);
			keyId = mintedKey.id;
			const encryptedKey = encryptProjectKey(
				mintedKey.key,
				dependencies.config.keyEncryptionKey,
			);
			const projectScopedClient = new NeonClient({
				apiKey: mintedKey.key,
				baseUrl: dependencies.config.neonApiHost,
			});
			const serviceCredentials = await configureCapabilities(
				projectScopedClient,
				project,
				capabilities,
				dataApiBody,
			);
			const assertion = await mintAssertion(dependencies.signingKey, {
				issuer: dependencies.config.issuer,
				audience: dependencies.config.audience,
				registrationId,
				expiresAt,
			});

			await createRegistration(dependencies.sql, {
				id: registrationId,
				identityType: request.type,
				neonProjectId: project.projectId,
				neonOrgId: dependencies.config.neonOrgId,
				neonBranchId: project.branchId,
				databaseName: project.databaseName,
				roleName: project.roleName,
				scopes,
				expiresAt,
				source: request.source,
			});
			await storeProjectKey(dependencies.sql, {
				registrationId,
				neonKeyId: mintedKey.id,
				...encryptedKey,
			});
			for (const [capability, credential] of Object.entries(serviceCredentials)) {
				if (
					(capability !== "auth" && capability !== "data_api") ||
					credential === undefined
				) {
					throw new ServiceError(
						"internal_error",
						"Provisioning produced an unknown service credential.",
					);
				}
				const encrypted = encryptProjectKey(
					JSON.stringify(credential),
					dependencies.config.keyEncryptionKey,
				);
				await storeServiceCredential(dependencies.sql, {
					registrationId,
					capability,
					...encrypted,
				});
			}
			await recordToken(dependencies.sql, {
				jti: assertion.jti,
				registrationId,
				kind: "assertion",
				scopes: [],
				expiresAt,
			});
			await recordCapabilityRequests(dependencies.sql, {
				registrationId,
				source: request.source,
				decisions,
			});
			await emitUsage(dependencies, "registration_created", {
				source: request.source,
				registrationId,
				projectId: project.projectId,
				identityType: request.type,
			});

			return context.json(
				{
					registration_id: registrationId,
					identity_assertion: assertion.token,
					claim_token: assertion.token,
					assertion_expires: Math.floor(expiresAt.getTime() / 1000),
					scopes,
					project: {
						id: project.projectId,
						branch_id: project.branchId,
						expires_at: expiresAt.toISOString(),
					},
					capabilities: decisions,
				},
				201,
			);
		} catch (error) {
			return cleanupProvisioning(dependencies, {
				registrationId,
				...(projectId ? { projectId } : {}),
				...(keyId !== undefined ? { keyId } : {}),
				original: error,
			});
		}
	});

	app.post("/v1/oauth2/token", async (context) => {
		const request = parseWith(
			tokenRequest,
			await parseFormBody(context.req.raw),
			"Token exchange request is not valid.",
		);
		if (
			request.resource !== undefined &&
			request.resource !== dependencies.config.audience
		) {
			throw new ServiceError(
				"invalid_grant",
				`Requested resource must be "${dependencies.config.audience}".`,
			);
		}
		const assertion = await verifyAssertion(
			dependencies.signingKey,
			request.assertion,
			tokenVerifyExpected(dependencies.config),
		);
		if (await isTokenRevoked(dependencies.sql, assertion.jti)) {
			throw new ServiceError("invalid_grant", "Identity assertion was revoked.");
		}
		const registration = await requireUsableRegistration(
			dependencies.sql,
			assertion.registration_id,
		);
		// Starting a claim freezes project mutations, not observation of the ceremony itself.
		// A client does not retain access tokens indefinitely, so refusing every later exchange
		// would make `GET .../claim` unreachable as soon as its first token expired. During the
		// ceremony, issue an empty-scope token so claim status and expired-window replacement
		// remain reachable without restoring project access.
		const accessScopes = registration.issuanceFrozen
			? []
			: withGrantableConfigureScopes(registration.scopes);
		const access = await mintAccessToken(dependencies.signingKey, {
			issuer: dependencies.config.issuer,
			audience: dependencies.config.audience,
			registrationId: registration.id,
			projectId: registration.neonProjectId,
			scopes: accessScopes,
			notAfter: registration.expiresAt,
		});
		await recordToken(dependencies.sql, {
			jti: access.jti,
			registrationId: registration.id,
			kind: "access",
			scopes: accessScopes,
			expiresAt: access.expiresAt,
		});
		await emitUsage(dependencies, "token_issued", {
			source: registration.source,
			registrationId: registration.id,
			projectId: registration.neonProjectId,
		});
		return context.json({
			access_token: access.token,
			token_type: "Bearer",
			expires_in: access.claims.exp - access.claims.iat,
			scope: access.claims.scope,
		});
	});

	app.post("/v1/oauth2/revoke", async (context) => {
		const request = parseWith(
			revokeRequest,
			await parseFormBody(context.req.raw),
			"Token revocation request is not valid.",
		);
		const jti = await revocationJti(dependencies, request.token);
		if (jti) await revokeToken(dependencies.sql, jti);
		return context.body(null, 200);
	});

	app.post("/v1/agent/identity/claim", async (context) => {
		const request = parseWith(
			claimTokenRequest,
			await parseJsonBody(context.req.raw),
			"Claim request is not valid.",
		);
		const assertion = await verifyAssertion(
			dependencies.signingKey,
			request.claim_token,
			tokenVerifyExpected(dependencies.config),
		);
		if (await isTokenRevoked(dependencies.sql, assertion.jti)) {
			throw new ServiceError("invalid_grant", "Claim token was revoked.");
		}
		const registration = await requireUsableRegistration(
			dependencies.sql,
			assertion.registration_id,
		);
		return withRegistrationLock(dependencies.sql, registration.id, async (lockedSql) => {
			const lockedDependencies = { ...dependencies, sql: lockedSql };
			const current = await requireUsableRegistration(lockedSql, registration.id);
			return context.json(await createClaimCode(lockedDependencies, current));
		});
	});

	app.post("/v1/projects/:projectId/claim", async (context) => {
		return withClaimCodeLock(
			context.req.header("authorization"),
			dependencies,
			async (authenticated, lockedDependencies) => {
				requireMatchingProject(
					authenticated.registration,
					context.req.param("projectId"),
				);
				return context.json(
					await createClaimCode(lockedDependencies, authenticated.registration),
				);
			},
		);
	});

	app.get("/v1/projects/:projectId/claim", async (context) => {
		return withClaimStatusLock(
			context.req.header("authorization"),
			dependencies,
			async (authenticated, lockedDependencies) => {
				const registration = authenticated.registration;
				requireMatchingProject(registration, context.req.param("projectId"));
				return context.json(await getClaimStatus(lockedDependencies, registration));
			},
		);
	});

	app.get("/claim", (context) => {
		const candidate = normalizeClaimCode(context.req.query("user_code") ?? "");
		const prefill = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/.test(candidate)
			? `${candidate.slice(0, 4)}-${candidate.slice(4)}`
			: "";
		return context.html(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Claim a Neon project</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { display: grid; min-height: 100vh; margin: 0; place-items: center; }
    main { width: min(28rem, calc(100% - 2rem)); }
    input, button { box-sizing: border-box; font: inherit; padding: .8rem 1rem; width: 100%; }
    input { margin: .5rem 0 1rem; letter-spacing: .12em; text-transform: uppercase; }
  </style>
</head>
<body>
  <main>
    <h1>Claim your Neon project</h1>
    <p>Enter the code shown by the agent. You will then sign in to Neon and choose the destination organization.</p>
    <form method="post" action="/claim">
      <label for="user_code">Claim code</label>
      <input id="user_code" name="user_code" value="${prefill}" autocomplete="one-time-code" required>
      <button type="submit">Continue to Neon</button>
    </form>
  </main>
</body>
</html>`);
	});

	app.post("/claim", async (context) => {
		const request = parseWith(
			claimCodeRequest,
			await parseFormBody(context.req.raw),
			"Claim code is required.",
		);
		const normalized = normalizeClaimCode(request.user_code);
		if (!/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/.test(normalized)) {
			throw new ServiceError("invalid_grant", "Claim code is not valid.");
		}
		const attempt = await findPendingClaimByCode(
			dependencies.sql,
			hashClaimCode(normalized),
		);
		if (!attempt) {
			throw new ServiceError(
				"invalid_grant",
				"Claim code is unknown, expired, or already used.",
			);
		}
		const registration = await findRegistration(dependencies.sql, attempt.registrationId);
		if (!registration) {
			throw new ServiceError("invalid_grant", "Claim registration no longer exists.");
		}
		return withRegistrationLock(dependencies.sql, registration.id, async (lockedSql) => {
			const lockedDependencies = { ...dependencies, sql: lockedSql };
			const currentAttempt = await latestClaimAttempt(lockedSql, registration.id);
			if (
				!currentAttempt ||
				currentAttempt.id !== attempt.id ||
				currentAttempt.state !== "pending"
			) {
				throw new ServiceError(
					"invalid_grant",
					"Claim code is unknown, expired, or already used.",
				);
			}
			if (currentAttempt.expiresAt.getTime() <= Date.now()) {
				await setClaimAttemptState(lockedSql, {
					attemptId: currentAttempt.id,
					state: "expired",
				});
				throw new ServiceError("invalid_grant", "Claim code has expired.");
			}
			const currentRegistration = await requireUsableRegistration(
				lockedSql,
				registration.id,
			);
			const transfer = await beginClaimTransfer(
				lockedDependencies,
				currentRegistration,
				currentAttempt,
			);
			if (transfer.prepared) {
				await emitUsage(lockedDependencies, "claim_started", {
					source: currentRegistration.source,
					registrationId: currentRegistration.id,
					projectId: currentRegistration.neonProjectId,
				});
			}
			const destination = new URL(lockedDependencies.config.consoleClaimUrl);
			destination.searchParams.set("p", currentRegistration.neonProjectId);
			destination.searchParams.set("tr", transfer.transferRequestId);
			return context.redirect(destination.toString(), 303);
		});
	});

	app.get("/v1/projects/:projectId/credentials", async (context) => {
		return withAuthenticatedRegistrationLock(
			context.req.header("authorization"),
			dependencies,
			async (authenticated, lockedDependencies) => {
				if (!hasScope(authenticated.tokenScopes, "postgres.read")) {
					throw new ServiceError(
						"scope_insufficient",
						"Fetching database credentials requires postgres.read.",
						{ requiredScope: "postgres.read" },
					);
				}
				const projectId = context.req.param("projectId");
				requireMatchingProject(authenticated.registration, projectId);
				const registration = authenticated.registration;
				const client = await projectClient(lockedDependencies, registration);
				const query = new URLSearchParams({
					branch_id: registration.neonBranchId,
					database_name: registration.databaseName,
					role_name: registration.roleName,
					pooled: "true",
				});
				const response = await client.get(
					`/projects/${encodeURIComponent(projectId)}/connection_uri?${query.toString()}`,
				);
				const connection = parseWith(
					connectionUriResponse,
					response.data,
					"Neon returned an invalid connection URI response.",
				);
				await recordDerivedCredential(lockedDependencies.sql, {
					registrationId: registration.id,
					kind: "connection_uri",
					branchId: registration.neonBranchId,
					scopes: ["postgres.read", "postgres.write"],
					expiresAt: registration.expiresAt,
				});
				await emitUsage(lockedDependencies, "credentials_read", {
					source: registration.source,
					registrationId: registration.id,
					projectId: projectId,
				});
				const storedServices = await getServiceCredentials(
					lockedDependencies.sql,
					registration.id,
				);
				const services: Record<string, unknown> = {};
				for (const stored of storedServices) {
					services[stored.capability] = decodeServiceCredential(
						stored.ciphertext,
						stored.nonce,
						lockedDependencies.config.keyEncryptionKey,
					);
				}
				return context.json({
					project_id: projectId,
					branch_id: registration.neonBranchId,
					database_url: connection.uri,
					expires_at: registration.expiresAt.toISOString(),
					services,
				});
			},
		);
	});

	app.delete("/v1/projects/:projectId", async (context) => {
		return withAuthenticatedRegistrationLock(
			context.req.header("authorization"),
			dependencies,
			async (authenticated, lockedDependencies) => {
				if (!hasScope(authenticated.tokenScopes, "postgres.write")) {
					throw new ServiceError(
						"scope_insufficient",
						"Deleting a claimable database requires postgres.write.",
						{ requiredScope: "postgres.write" },
					);
				}
				const projectId = context.req.param("projectId");
				const registration = authenticated.registration;
				requireMatchingProject(registration, projectId);
				const storedKey = await getProjectKey(lockedDependencies.sql, registration.id);
				await deleteClaimableProject(lockedDependencies.orgClient, projectId);
				await revokeProjectKey(
					lockedDependencies.orgClient,
					lockedDependencies.config.neonOrgId,
					storedKey.neonKeyId,
				);
				await revokeAllTokens(lockedDependencies.sql, registration.id);
				await markProjectKeyRevoked(lockedDependencies.sql, registration.id);
				await revokeRegistration(
					lockedDependencies.sql,
					registration.id,
					"deleted_by_agent",
				);
				await emitUsage(lockedDependencies, "registration_deleted", {
					source: registration.source,
					registrationId: registration.id,
					projectId: projectId,
				});
				return context.body(null, 204);
			},
		);
	});

	app.all("/v1/projects/*", async (context) => {
		return withAuthenticatedRegistrationLock(
			context.req.header("authorization"),
			dependencies,
			(authenticated, lockedDependencies) =>
				proxyManagementRequest(context.req.raw, lockedDependencies, authenticated),
		);
	});

	app.notFound((context) => {
		const error = new ServiceError("not_found", "No route exists at this path.");
		return errorResponse(
			error,
			context.get("requestId"),
			dependencies.config.publicOrigin,
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
		if (context.req.method === "POST" && context.req.path === "/claim") {
			return claimErrorResponse(serviceError, requestId);
		}
		return errorResponse(serviceError, requestId, dependencies.config.publicOrigin);
	});

	return app;
};
