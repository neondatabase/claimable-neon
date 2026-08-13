/**
 * Product analytics.
 *
 * Same client as CLI and MCP: `@segment/analytics-node` pointed at
 * `https://track.neon.tech`. That host is the analytics-events service, which
 * dual-writes to Databricks Zerobus (and, while the sunset runs, Segment).
 *
 * Until `ANALYTICS_WRITE_KEY` is set to a key listed in analytics-events
 * `accepted_write_keys`, track is a no-op. `usage_events` in the state database
 * is local durability, not the warehouse path.
 *
 * An analytics failure must not fail a request. Flush on every response
 * (`flushAt: 1` is not a substitute for the request-end barrier on a Function).
 */

import { Analytics as SegmentAnalytics } from "@segment/analytics-node";

const TRACK_HOST = "https://track.neon.tech";
const ANONYMOUS = "anonymous";

export type Analytics = {
	track: (event: string, properties?: Record<string, string | number | boolean>) => void;
	flush: () => Promise<void>;
};

const silentAnalytics: Analytics = {
	track: () => {},
	flush: async () => {},
};

export const createAnalytics = (writeKey: string | undefined): Analytics => {
	if (writeKey === undefined) {
		return silentAnalytics;
	}

	const client = new SegmentAnalytics({
		writeKey,
		host: TRACK_HOST,
		flushAt: 1,
	});

	return {
		track: (event, properties) => {
			try {
				client.track({
					userId: ANONYMOUS,
					event,
					properties,
				});
			} catch (error: unknown) {
				console.error("claimable-neon analytics track failed:", error);
			}
		},
		flush: async () => {
			try {
				await client.flush();
			} catch (error: unknown) {
				console.error("claimable-neon analytics flush failed:", error);
			}
		},
	};
};
