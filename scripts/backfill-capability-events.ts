/**
 * Replays capability requests created before `--before` to track.neon.tech as
 * `capability_requested` events with their original timestamps:
 *
 * - `capability_requests` rows (stage `create`)
 * - `usage_events` rows for `capability_requested` (stage `proxy`)
 *
 *   node --env-file=<env> --experimental-strip-types scripts/backfill-capability-events.ts \
 *     --before <ISO> [--dry-run]
 *
 * Needs DATABASE_URL (the state database to read), PUBLIC_ORIGIN (the origin of the service that
 * wrote it), and ANALYTICS_WRITE_KEY. Message ids match the live emitter. The dbt stage dedupes only within a received_at microbatch, so a re-run or an
 * overlap with live traffic adds rows with an existing id to the fact; the Orbit capability
 * rollup counts distinct ids and is unaffected.
 *
 * Proxy-stage rows were all sent live. Replaying them repairs rows the stage built before it
 * projected the capability columns (anything received more than its 3-day lookback before the
 * dbt change ran).
 */

import { parseArgs } from "node:util";
import { Analytics as SegmentAnalytics } from "@segment/analytics-node";
import { Pool } from "pg";

import { ANONYMOUS, TRACK_HOST } from "../lib/analytics/analytics.ts";
import {
	capabilityRequestedEvent,
	isTrackedCapabilityRequest,
	usageEventTrackEvent,
} from "../lib/analytics/events.ts";
import {
	listCapabilityRequestsBefore,
	listUsageEventsBefore,
} from "../lib/store/store.ts";

const BATCH = 500;

const { values } = parseArgs({
	options: {
		before: { type: "string" },
		"dry-run": { type: "boolean", default: false },
	},
});

const before = new Date(values.before ?? "");
if (Number.isNaN(before.getTime())) {
	throw new Error("--before must be an ISO timestamp, e.g. 2026-11-05T20:00:00Z.");
}
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
const origin = process.env.PUBLIC_ORIGIN;
if (!origin) throw new Error("PUBLIC_ORIGIN is required.");
const writeKey = process.env.ANALYTICS_WRITE_KEY?.trim();
if (!values["dry-run"] && !writeKey) throw new Error("ANALYTICS_WRITE_KEY is required.");

const sql = new Pool({ connectionString: databaseUrl, max: 1 });
const [createRows, proxyRows] = await Promise.all([
	listCapabilityRequestsBefore(sql, before),
	listUsageEventsBefore(sql, "capability_requested", before),
]).finally(() => sql.end());
const events = [
	...createRows
		.filter(isTrackedCapabilityRequest)
		.map((row) => capabilityRequestedEvent(row, origin)),
	...proxyRows.map((row) => usageEventTrackEvent(row, origin)),
];

const counts = new Map<string, number>();
for (const { properties } of events) {
	const key = `${properties.stage} ${properties.capability} granted=${properties.granted}`;
	counts.set(key, (counts.get(key) ?? 0) + 1);
}
console.log(`${events.length} capability requests before ${before.toISOString()}`);
for (const [key, count] of [...counts].sort((a, b) => b[1] - a[1])) {
	console.log(`  ${count}\t${key}`);
}

if (!values["dry-run"] && writeKey) {
	const client = new SegmentAnalytics({ writeKey, host: TRACK_HOST, flushAt: BATCH });
	const failures: unknown[] = [];
	client.on("error", (error) => failures.push(error));

	for (let start = 0; start < events.length && failures.length === 0; start += BATCH) {
		for (const { event, properties, options } of events.slice(start, start + BATCH)) {
			client.track({ userId: ANONYMOUS, event, properties, ...options });
		}
		await client.flush();
		console.log(`sent ${Math.min(start + BATCH, events.length)}/${events.length}`);
	}
	await client.closeAndFlush();

	if (failures.length > 0) {
		console.error(failures[0]);
		throw new Error(`${failures.length} delivery failures; re-running is safe.`);
	}
}
