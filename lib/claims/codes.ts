import { createHash, randomInt } from "node:crypto";

const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LENGTH = 8;

export const normalizeClaimCode = (value: string): string =>
	value.toUpperCase().replaceAll(/[\s-]/g, "");

export const generateClaimCode = (): string => {
	let raw = "";
	for (let index = 0; index < CODE_LENGTH; index += 1) {
		raw += ALPHABET.charAt(randomInt(ALPHABET.length));
	}
	return `${raw.slice(0, 4)}-${raw.slice(4)}`;
};

export const hashClaimCode = (value: string): string =>
	createHash("sha256").update(normalizeClaimCode(value)).digest("hex");
