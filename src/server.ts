import { createAnalytics } from "../lib/analytics/analytics.ts";
import { createApp } from "../lib/app/app.ts";
import { loadConfig } from "../lib/config/config.ts";
import { NeonClient } from "../lib/neon/client.ts";
import { assertNeonApiKeyKinds } from "../lib/neon/key-kind.ts";
import { connect } from "../lib/store/store.ts";
import { importSigningKey } from "../lib/tokens/keys.ts";

const config = loadConfig(process.env);
const signingKey = await importSigningKey(config.tokenSigningKey);
const sql = connect(config.databaseUrl);

const orgClient = new NeonClient({
	apiKey: config.neonOrgApiKey,
	baseUrl: config.neonApiHost,
});
const personalClient = new NeonClient({
	apiKey: config.neonApiKey,
	baseUrl: config.neonApiHost,
});
await assertNeonApiKeyKinds(personalClient, orgClient);

const app = createApp({
	config,
	sql,
	signingKey,
	orgClient,
	personalClient,
	analytics: createAnalytics(config.analyticsWriteKey),
});

export const closeDatabase = async (): Promise<void> => {
	await sql.end({ timeout: 5 });
};

export default app;
