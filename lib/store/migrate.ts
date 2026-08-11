import { ServiceError } from "../errors/errors.ts";
import { connect, migrate } from "./store.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
	throw new ServiceError("internal_error", "DATABASE_URL is required to run migrations.");
}

const sql = connect(databaseUrl);
try {
	await migrate(sql);
} finally {
	await sql.end({ timeout: 5 });
}
