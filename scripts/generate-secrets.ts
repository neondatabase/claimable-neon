import { randomBytes } from "node:crypto";

import { exportSigningKey, generateSigningKey } from "../lib/tokens/keys.ts";

const signingKey = await exportSigningKey(await generateSigningKey());
const encryptionKey = randomBytes(32).toString("base64");

console.log(`TOKEN_SIGNING_KEY='${signingKey}'`);
console.log(`KEY_ENCRYPTION_KEY='${encryptionKey}'`);
