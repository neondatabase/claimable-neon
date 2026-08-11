import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { ServiceError } from "../errors/errors.ts";

const ALGORITHM = "aes-256-gcm";
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export type EncryptedProjectKey = {
	ciphertext: Buffer;
	nonce: Buffer;
};

export const encryptProjectKey = (value: string, key: Buffer): EncryptedProjectKey => {
	const nonce = randomBytes(NONCE_BYTES);
	const cipher = createCipheriv(ALGORITHM, key, nonce);
	const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
	return {
		ciphertext: Buffer.concat([encrypted, cipher.getAuthTag()]),
		nonce,
	};
};

export const decryptProjectKey = (
	encrypted: EncryptedProjectKey,
	key: Buffer,
): string => {
	if (encrypted.ciphertext.length <= AUTH_TAG_BYTES) {
		throw new ServiceError("internal_error", "Encrypted project key is truncated.");
	}
	try {
		const tagOffset = encrypted.ciphertext.length - AUTH_TAG_BYTES;
		const ciphertext = encrypted.ciphertext.subarray(0, tagOffset);
		const authTag = encrypted.ciphertext.subarray(tagOffset);
		const decipher = createDecipheriv(ALGORITHM, key, encrypted.nonce);
		decipher.setAuthTag(authTag);
		return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
			"utf8",
		);
	} catch (cause) {
		throw new ServiceError(
			"internal_error",
			"Stored project key could not be decrypted.",
			{ cause },
		);
	}
};
