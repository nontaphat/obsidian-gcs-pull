import type { GcsObject } from "../gcs/GcsReadClient";
import type { LocalTarget } from "../local/LocalTarget";
import { sha256 } from "../util/hash";
import { isExcludedPath } from "./exclusions";
import { PullBaseline, PullIssue, PullPlan, PullPlanItem, PullRunResult } from "./types";

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
		private readonly excludedFolders: readonly string[] = []
	) {}

	async preview(previous: PullBaseline): Promise<PullPlan> {
		const remoteObjects = await this.remote.list();
		if (this.cancelled()) throw new Error("Pull cancelled because the plugin unloaded.");
		const issues: PullIssue[] = [];
		const resolved: ResolvedObject[] = [];
		let excluded = 0;

		for (const remote of remoteObjects) {
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
					unchanged += 1;
					unchangedBaseline[item.remote.relativePath] = prior;
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

		return {
			scanned: remoteObjects.length,
			excluded,
			toPull: items.length,
			newFiles,
			updatedFiles,
			unchanged,
			backupExpected,
			errorCount: issues.length,
			items,
			issues,
			unchangedBaseline,
		};
	}

	async apply(plan: PullPlan, onProgress?: (progress: PullProgress) => void): Promise<PullRunResult> {
		const baseline: PullBaseline = { ...plan.unchangedBaseline };
		const issues = [...plan.issues];
		const files: string[] = [];
		let downloadedNew = 0;
		let downloadedUpdated = 0;
		let alreadyCurrent = 0;
		let backupsCreated = 0;

		let completed = 0;
		for (const item of plan.items) {
			if (this.cancelled()) {
				issues.push({ path: item.remote.relativePath, message: "Pull cancelled because the plugin unloaded." });
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
				if (exists) downloadedUpdated += 1;
				else downloadedNew += 1;
				files.push(item.remote.relativePath);
				baseline[item.remote.relativePath] = { generation: item.remote.generation, localHash: remoteHash };
			} catch (error) {
				issues.push({ path: item.remote.relativePath, message: this.message(error) });
				if (item.previous) baseline[item.remote.relativePath] = item.previous;
			} finally {
				completed += 1;
				onProgress?.({ completed, total: plan.items.length });
			}
		}

		return {
			scanned: plan.scanned,
			excluded: plan.excluded,
			downloadedNew,
			downloadedUpdated,
			alreadyCurrent,
			unchanged: plan.unchanged,
			backupsCreated,
			errorCount: issues.length,
			files,
			issues,
			baseline,
		};
	}

	private message(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}
