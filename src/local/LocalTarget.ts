import { App, normalizePath } from "obsidian";
import { joinVaultPath } from "../safety/paths";

export interface LocalTarget {
	resolve(remotePath: string): { path: string; collisionKey: string };
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<ArrayBuffer>;
	write(path: string, data: ArrayBuffer): Promise<void>;
	backup(path: string, data: ArrayBuffer, now: Date): Promise<string>;
}

export class ObsidianLocalTarget implements LocalTarget {
	constructor(
		private readonly app: App,
		private readonly root: string
	) {}

	resolve(remotePath: string): { path: string; collisionKey: string } {
		const resolved = joinVaultPath(this.root, remotePath, this.app.vault.configDir);
		return { path: normalizePath(resolved.relative), collisionKey: resolved.collisionKey };
	}

	exists(path: string): Promise<boolean> {
		return this.app.vault.adapter.exists(normalizePath(path));
	}

	read(path: string): Promise<ArrayBuffer> {
		return this.app.vault.adapter.readBinary(normalizePath(path));
	}

	async write(path: string, data: ArrayBuffer): Promise<void> {
		const normalized = normalizePath(path);
		await this.ensureParent(normalized);
		await this.app.vault.adapter.writeBinary(normalized, data);
	}

	async backup(path: string, data: ArrayBuffer, now: Date): Promise<string> {
		const slash = path.lastIndexOf("/");
		const directory = slash >= 0 ? path.slice(0, slash + 1) : "";
		const fileName = slash >= 0 ? path.slice(slash + 1) : path;
		const dot = fileName.lastIndexOf(".");
		const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
		const extension = dot > 0 ? fileName.slice(dot) : "";
		const stamp = now.toISOString().replace(/[-:.TZ]/g, "");
		let suffix = "";
		let attempt = 1;
		let candidate: string;
		do {
			candidate = `${directory}${stem}.conflict-${stamp}${suffix}${extension}`;
			attempt += 1;
			suffix = `-${attempt}`;
		} while (await this.exists(candidate));
		await this.write(candidate, data);
		return candidate;
	}

	private async ensureParent(path: string): Promise<void> {
		const slash = path.lastIndexOf("/");
		if (slash < 1) return;
		const parts = path.slice(0, slash).split("/");
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!(await this.app.vault.adapter.exists(current))) await this.app.vault.adapter.mkdir(current);
		}
	}
}
