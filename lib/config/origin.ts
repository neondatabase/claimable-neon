export const isLocalhostHostname = (hostname: string): boolean =>
	hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
