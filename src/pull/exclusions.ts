export function parseExcludedFolders(value: string): string[] {
	const folders = value
		.split(/[\n,]+/)
		.map((entry) => normalizeFolder(entry))
		.filter((entry): entry is string => entry !== null)
		.sort((left, right) => left.length - right.length || left.localeCompare(right));

	const unique: string[] = [];
	for (const folder of folders) {
		if (unique.some((parent) => folder === parent || folder.startsWith(`${parent}/`))) continue;
		unique.push(folder);
	}
	return unique;
}

export function isExcludedPath(path: string, folders: readonly string[]): boolean {
	const normalized = path.normalize("NFC");
	return folders.some((folder) => normalized.startsWith(`${folder}/`));
}

function normalizeFolder(value: string): string | null {
	const trimmed = value.trim().replace(/^\/+|\/+$/g, "");
	if (!trimmed) return null;
	if (trimmed.includes("\0")) throw new Error("An excluded folder contains a null character.");
	if (trimmed.includes("\\")) throw new Error("Use forward slashes in excluded folder paths.");
	const segments = trimmed.split("/");
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
		throw new Error(`Excluded folder path is invalid: ${value.trim()}`);
	}
	return segments.map((segment) => segment.normalize("NFC")).join("/");
}
