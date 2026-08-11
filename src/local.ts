import { serve } from "@hono/node-server";

import app, { closeDatabase } from "./server.ts";

const portValue = process.env.PORT ?? "8787";
const port = Number(portValue);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
	throw new Error(`PORT must be an integer from 1 to 65535, got "${portValue}".`);
}

const server = serve({ fetch: app.fetch, port }, (info) => {
	console.log(`Claimable Neon listening on http://localhost:${info.port}`);
});

const shutdown = (): void => {
	server.close(() => {
		closeDatabase()
			.then(() => process.exit(0))
			.catch((error: unknown) => {
				console.error(error);
				process.exit(1);
			});
	});
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
