import { createAnalytics } from "../lib/analytics/analytics.ts";
import { createApp } from "../lib/app/app.ts";
import { loadConfig } from "../lib/config/config.ts";
import { NeonClient } from "../lib/neon/client.ts";
import { connect } from "../lib/store/store.ts";
import { importSigningKey } from "../lib/tokens/keys.ts";

const config = loadConfig(process.env);
const signingKey = await importSigningKey(config.tokenSigningKey);
const sql = connect(config.databaseUrl);

const app = createApp({
	config,
	sql,
	signingKey,
	orgClient: new NeonClient({
		apiKey: config.neonApiKey,
		baseUrl: config.neonApiHost,
	}),
	analytics: createAnalytics(config.analyticsWriteKey),
});

export const closeDatabase = async (): Promise<void> => {
	await sql.end({ timeout: 5 });
};

export default app;
