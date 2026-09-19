import "./instrument.ts";

import { createAnalytics } from "../lib/analytics/analytics.ts";
import { createJanitorApp } from "../lib/janitor/app.ts";
import { loadJanitorConfig } from "../lib/janitor/config.ts";
import { NeonClient } from "../lib/neon/client.ts";
import { assertOrganizationApiKeyKind, probeUsersMeKind } from "../lib/neon/key-kind.ts";
import { connect } from "../lib/store/store.ts";

const config = loadJanitorConfig(process.env);
const sql = connect(config.databaseUrl);
const orgClient = new NeonClient({
	apiKey: config.neonOrgApiKey,
	baseUrl: config.neonApiHost,
});
assertOrganizationApiKeyKind(await probeUsersMeKind(orgClient));

const app = createJanitorApp({
	config,
	sql,
	orgClient,
	analytics: createAnalytics(config.analyticsWriteKey),
});

export const closeDatabase = async (): Promise<void> => {
	await sql.end();
};

export default app;
