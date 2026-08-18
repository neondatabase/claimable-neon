import { Hono } from "hono";

import { createForwarderApp, loadForwarderConfig } from "./lib/edge/forward.ts";

// Vercel only treats a file as the Hono entry if this module imports `hono`.
// It compiles this file to server.js and keeps the `.ts` specifiers, so
// vercel.json includeFiles has to ship `lib/` into the lambda.
export default createForwarderApp(loadForwarderConfig(process.env), new Hono());
