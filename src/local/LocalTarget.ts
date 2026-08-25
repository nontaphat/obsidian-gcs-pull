import { App, normalizePath, TFile, TFolder } from "obsidian";
import { joinVaultPath } from "../safety/paths";

export interface LocalTarget {
	resolve(remotePath: string): { path: string; collisionKey: string };
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<ArrayBuffer>;
	write(path: string, data: ArrayBuffer): Promise<void>;
	backup(path: string, data: ArrayBuffer, now: Date): Promise<string>;
	trash(path: string): Promise<void>;
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
		return Promise.resolve(this.app.vault.getAbstractFileByPath(normalizePath(path)) !== null);
	}

	async read(path: string): Promise<ArrayBuffer> {
		const file = this.app.vault.getFileByPath(normalizePath(path));
		if (!file) throw new Error(`Local file does not exist: ${path}`);
		return this.app.vault.readBinary(file);
	}

	async write(path: string, data: ArrayBuffer): Promise<void> {
		const normalized = normalizePath(path);
		await this.ensureParent(normalized);
		const existing = this.app.vault.getAbstractFileByPath(normalized);
		if (existing instanceof TFile) await this.app.vault.modifyBinary(existing, data);
		else if (existing) throw new Error(`Local path is not a file: ${normalized}`);
		else await this.app.vault.createBinary(normalized, data);
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

	async trash(path: string): Promise<void> {
		const existing = this.app.vault.getAbstractFileByPath(normalizePath(path));
		if (!existing) return;
		if (!(existing instanceof TFile)) throw new Error(`Local path is not a file: ${path}`);
		await this.app.fileManager.trashFile(existing);
	}

	private async ensureParent(path: string): Promise<void> {
		const slash = path.lastIndexOf("/");
		if (slash < 1) return;
		const parts = path.slice(0, slash).split("/");
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			const existing = this.app.vault.getAbstractFileByPath(current);
			if (existing instanceof TFolder) continue;
			if (existing) throw new Error(`Local parent path is not a folder: ${current}`);
			await this.app.vault.createFolder(current);
		}
	}
}
