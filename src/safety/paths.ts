export interface SafePath {
	relative: string;
	collisionKey: string;
}

function segments(path: string, allowEmpty: boolean): string[] {
	if (path.includes("\0")) throw new Error("Path contains a null character.");
	if (path.includes("\\")) throw new Error("Backslashes are not allowed in GCS object paths.");
	if (path.startsWith("/")) throw new Error("Absolute object paths are not allowed.");
	if (path.endsWith("/")) throw new Error("Folder-marker objects are not files.");
	if (!path) {
		if (allowEmpty) return [];
		throw new Error("Object path is empty.");
	}
	const parts = path.split("/");
	if (parts.some((part) => part === "" || part === "." || part === "..")) {
		throw new Error("Object path contains an empty or relative segment.");
	}
	return parts.map((part) => part.normalize("NFC"));
}

export function safeRemotePath(path: string): SafePath {
	const relative = segments(path, false).join("/");
	return { relative, collisionKey: relative.toLowerCase() };
}

export function safeTargetRoot(path: string, configDir: string): string {
	const root = segments(path.trim().replace(/\/+$/, ""), true).join("/");
	const config = configDir.normalize("NFC").toLowerCase();
	const folded = root.toLowerCase();
	if (folded === config || folded.startsWith(`${config}/`)) {
		throw new Error(`Destination cannot be inside ${configDir}.`);
	}
	return root;
}

export function joinVaultPath(root: string, remotePath: string, configDir: string): SafePath {
	const safeRoot = safeTargetRoot(root, configDir);
	const safeRemote = safeRemotePath(remotePath);
	const relative = safeRoot ? `${safeRoot}/${safeRemote.relative}` : safeRemote.relative;
	const folded = relative.toLowerCase();
	const config = configDir.normalize("NFC").toLowerCase();
	if (folded === config || folded.startsWith(`${config}/`)) {
		throw new Error(`Object would write inside ${configDir}.`);
	}
	return { relative, collisionKey: relative.toLowerCase() };
}
