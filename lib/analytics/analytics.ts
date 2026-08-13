/**
 * Product analytics.
 *
 * CLI and MCP send Segment events to `https://track.neon.tech` (a Segment-compatible
 * proxy). This service does the same HTTP `POST /v1/track` so usage lands in the same
 * pipeline once a dedicated write key exists. Until `ANALYTICS_WRITE_KEY` is set, track
 * is a no-op; the durable record is `usage_events` in the state database.
 *
 * A Segment failure must not fail a request. The warehouse rollup reads Postgres, not
 * the live stream.
 */

const TRACK_URL = "https://track.neon.tech/v1/track";
const ANONYMOUS = "anonymous";

export type Analytics = {
	track: (event: string, properties?: Record<string, string | number | boolean>) => void;
	flush: () => Promise<void>;
};

const silentAnalytics: Analytics = {
	track: () => {},
	flush: async () => {},
};

const basicAuth = (writeKey: string): string =>
	`Basic ${Buffer.from(`${writeKey}:`).toString("base64")}`;

export const createAnalytics = (writeKey: string | undefined): Analytics => {
	if (writeKey === undefined) {
		return silentAnalytics;
	}

	const pending = new Set<Promise<void>>();

	const send = async (
		event: string,
		properties: Record<string, string | number | boolean> | undefined,
	): Promise<void> => {
		const response = await fetch(TRACK_URL, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: basicAuth(writeKey),
			},
			body: JSON.stringify({
				userId: ANONYMOUS,
				event,
				properties,
				timestamp: new Date().toISOString(),
			}),
		});
		if (!response.ok) {
			const body = await response.text();
			console.error(
				`claimable-neon analytics track failed: HTTP ${response.status} ${body}`,
			);
		}
	};

	return {
		track: (event, properties) => {
			const run = send(event, properties).catch((error: unknown) => {
				console.error("claimable-neon analytics track failed:", error);
			});
			pending.add(run);
			void run.finally(() => {
				pending.delete(run);
			});
		},
		flush: async () => {
			await Promise.all([...pending]);
		},
	};
};
