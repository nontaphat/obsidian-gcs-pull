import type { GcsObject } from "../gcs/GcsReadClient";
import type { LocalTarget } from "../local/LocalTarget";
import { sha256 } from "../util/hash";
import type { PullMode } from "../settings";
import { isExcludedPath } from "./exclusions";
import { PullBaseline, PullIssue, PullPlan, PullPlanItem, PullRunResult, PullTrashItem } from "./types";

export interface RemoteReader {
	list(): Promise<GcsObject[]>;
	download(object: GcsObject): Promise<ArrayBuffer>;
}

export interface PullProgress {
	completed: number;
	total: number;
}

interface ResolvedObject {
	remote: GcsObject;
	destination: string;
	collisionKey: string;
}

export class PullEngine {
	constructor(
		private readonly remote: RemoteReader,
		private readonly local: LocalTarget,
		private readonly now: () => Date = () => new Date(),
		private readonly cancelled: () => boolean = () => false,
		private readonly excludedFolders: readonly string[] = [],
		private readonly mode: PullMode = "safe"
	) {}

	async preview(previous: PullBaseline): Promise<PullPlan> {
		const remoteObjects = await this.remote.list();
		if (this.cancelled()) throw new Error("Pull cancelled because the plugin unloaded.");
		const issues: PullIssue[] = [];
		const resolved: ResolvedObject[] = [];
		const listedPaths = new Set<string>();
		let excluded = 0;

		for (const remote of remoteObjects) {
			listedPaths.add(remote.relativePath);
			if (isExcludedPath(remote.relativePath, this.excludedFolders)) {
				excluded += 1;
				continue;
			}
			try {
				const destination = this.local.resolve(remote.relativePath);
				resolved.push({ remote, destination: destination.path, collisionKey: destination.collisionKey });
			} catch (error) {
				issues.push({ path: remote.relativePath, message: this.message(error) });
			}
		}

		const collisionCounts = new Map<string, number>();
		for (const item of resolved) collisionCounts.set(item.collisionKey, (collisionCounts.get(item.collisionKey) ?? 0) + 1);

		const items: PullPlanItem[] = [];
		const unchangedBaseline: PullBaseline = {};
		for (const [path, baseline] of Object.entries(previous)) {
			if (isExcludedPath(path, this.excludedFolders)) unchangedBaseline[path] = baseline;
		}
		let unchanged = 0;
		let newFiles = 0;
		let updatedFiles = 0;
		let localEditsToReplace = 0;
		let backupExpected = 0;

		for (const item of resolved) {
			if (this.cancelled()) throw new Error("Pull cancelled because the plugin unloaded.");
			if ((collisionCounts.get(item.collisionKey) ?? 0) > 1) {
				issues.push({ path: item.remote.relativePath, message: "Multiple GCS objects map to the same local path." });
				continue;
			}
			const prior = previous[item.remote.relativePath];
			try {
				const exists = await this.local.exists(item.destination);
				if (exists && prior?.generation === item.remote.generation) {
					if (this.mode === "safe") {
						unchanged += 1;
						unchangedBaseline[item.remote.relativePath] = prior;
						continue;
					}
					const localHash = await sha256(await this.local.read(item.destination));
					if (localHash === prior.localHash) {
						unchanged += 1;
						unchangedBaseline[item.remote.relativePath] = prior;
						continue;
					}
					localEditsToReplace += 1;
					backupExpected += 1;
					items.push({
						remote: item.remote,
						destination: item.destination,
						previous: prior,
						kind: "restore",
						backupExpected: true,
					});
					continue;
				}
				if (!exists) {
					newFiles += 1;
					items.push({ remote: item.remote, destination: item.destination, previous: prior, kind: "new", backupExpected: false });
					continue;
				}
				const localHash = await sha256(await this.local.read(item.destination));
				const needsBackup = !prior || localHash !== prior.localHash;
				updatedFiles += 1;
				if (needsBackup) backupExpected += 1;
				items.push({
					remote: item.remote,
					destination: item.destination,
					previous: prior,
					kind: "update",
					backupExpected: needsBackup,
				});
			} catch (error) {
				issues.push({ path: item.remote.relativePath, message: this.message(error) });
				if (prior) unchangedBaseline[item.remote.relativePath] = prior;
			}
		}

		const trashItems: PullTrashItem[] = [];
		if (this.mode === "mirror") {
			for (const [relativePath, prior] of Object.entries(previous)) {
				if (listedPaths.has(relativePath) || isExcludedPath(relativePath, this.excludedFolders)) continue;
				try {
					const destination = this.local.resolve(relativePath).path;
					if (await this.local.exists(destination)) trashItems.push({ relativePath, destination, previous: prior });
				} catch (error) {
					issues.push({ path: relativePath, message: this.message(error) });
					unchangedBaseline[relativePath] = prior;
				}
			}
		}

		return {
			scanned: remoteObjects.length,
			excluded,
			toPull: items.length,
			newFiles,
			updatedFiles,
			localEditsToReplace,
			toTrash: trashItems.length,
			unchanged,
			backupExpected,
			errorCount: issues.length,
			items,
			trashItems,
			issues,
			unchangedBaseline,
		};
	}

	async apply(plan: PullPlan, onProgress?: (progress: PullProgress) => void, allowDestructive = true): Promise<PullRunResult> {
		const baseline: PullBaseline = { ...plan.unchangedBaseline };
		const issues = [...plan.issues];
		const files: string[] = [];
		const trashedFiles: string[] = [];
		let downloadedNew = 0;
		let downloadedUpdated = 0;
		let restoredLocal = 0;
		let movedToTrash = 0;
		let destructiveDeferred = 0;
		let alreadyCurrent = 0;
		let backupsCreated = 0;

		const applicableItems = plan.items.filter((item) => item.kind !== "restore" || allowDestructive);
		for (const item of plan.items) {
			if (item.kind === "restore" && !allowDestructive) {
				destructiveDeferred += 1;
				if (item.previous) baseline[item.remote.relativePath] = item.previous;
			}
		}
		const mayTrash = allowDestructive && issues.length === 0;
		const progressTotal = applicableItems.length + (mayTrash ? plan.trashItems.length : 0);
		let completed = 0;
		for (let index = 0; index < applicableItems.length; index += 1) {
			const item = applicableItems[index]!;
			if (this.cancelled()) {
				issues.push({ path: item.remote.relativePath, message: "Pull cancelled because the plugin unloaded." });
				for (const pending of applicableItems.slice(index)) {
					if (pending.previous) baseline[pending.remote.relativePath] = pending.previous;
				}
				break;
			}
			try {
				const remoteBytes = await this.remote.download(item.remote);
				if (this.cancelled()) throw new Error("Pull cancelled because the plugin unloaded.");
				const remoteHash = await sha256(remoteBytes);
				const exists = await this.local.exists(item.destination);
				if (exists) {
					const localBytes = await this.local.read(item.destination);
					const localHash = await sha256(localBytes);
					if (localHash === remoteHash) {
						alreadyCurrent += 1;
						baseline[item.remote.relativePath] = { generation: item.remote.generation, localHash: remoteHash };
						continue;
					}
					if (!item.previous || localHash !== item.previous.localHash) {
						await this.local.backup(item.destination, localBytes, this.now());
						backupsCreated += 1;
					}
				}

				await this.local.write(item.destination, remoteBytes);
				if (item.kind === "restore") restoredLocal += 1;
				else if (exists) downloadedUpdated += 1;
				else downloadedNew += 1;
				files.push(item.remote.relativePath);
				baseline[item.remote.relativePath] = { generation: item.remote.generation, localHash: remoteHash };
			} catch (error) {
				issues.push({ path: item.remote.relativePath, message: this.message(error) });
				if (item.previous) baseline[item.remote.relativePath] = item.previous;
			} finally {
				completed += 1;
				onProgress?.({ completed, total: progressTotal });
			}
		}

		const canTrash = mayTrash && issues.length === 0;
		if (canTrash) {
			for (let index = 0; index < plan.trashItems.length; index += 1) {
				const item = plan.trashItems[index]!;
				if (this.cancelled()) {
					issues.push({ path: item.relativePath, message: "Pull cancelled because the plugin unloaded." });
					this.deferTrash(plan.trashItems.slice(index), baseline);
					destructiveDeferred += plan.trashItems.length - index;
					break;
				}
				try {
					await this.local.trash(item.destination);
					movedToTrash += 1;
					trashedFiles.push(item.relativePath);
				} catch (error) {
					issues.push({ path: item.relativePath, message: this.message(error) });
					this.deferTrash(plan.trashItems.slice(index), baseline);
					destructiveDeferred += plan.trashItems.length - index;
					break;
				} finally {
					completed += 1;
					onProgress?.({ completed, total: progressTotal });
				}
			}
		} else {
			destructiveDeferred += plan.trashItems.length;
			this.deferTrash(plan.trashItems, baseline);
		}

		return {
			scanned: plan.scanned,
			excluded: plan.excluded,
			downloadedNew,
			downloadedUpdated,
			restoredLocal,
			movedToTrash,
			destructiveDeferred,
			alreadyCurrent,
			unchanged: plan.unchanged,
			backupsCreated,
			errorCount: issues.length,
			files,
			trashedFiles,
			issues,
			baseline,
		};
	}

	private message(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	private deferTrash(items: PullTrashItem[], baseline: PullBaseline): void {
		for (const item of items) baseline[item.relativePath] = item.previous;
	}
}
