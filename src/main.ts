import { Notice, Plugin } from "obsidian";
import { GoogleOAuth, OAuthTokens } from "./auth/GoogleOAuth";
import { GcsReadClient } from "./gcs/GcsReadClient";
import { ObsidianLocalTarget } from "./local/LocalTarget";
import { obsidianHttp } from "./net/http";
import { PullEngine } from "./pull/PullEngine";
import { parseExcludedFolders } from "./pull/exclusions";
import { PullPlan } from "./pull/types";
import { DEFAULT_SETTINGS, PluginSettings, loadSettings } from "./settings";
import { confirmMirrorPull } from "./ui/ConfirmModal";
import { GoogleGcsPullSettingsTab } from "./ui/SettingsTab";

export default class GoogleGcsPullPlugin extends Plugin {
	settings: PluginSettings = { ...DEFAULT_SETTINGS };
	private oauth!: GoogleOAuth;
	private access: { token: string; expiresAt: number } | null = null;
	private operationRunning = false;
	private unloaded = false;

	async onload(): Promise<void> {
		this.unloaded = false;
		this.settings = loadSettings(await this.loadData());
		this.oauth = new GoogleOAuth(obsidianHttp);

		this.addCommand({
			id: "preview-changes",
			name: "Preview changes",
			callback: () => void this.previewPull(),
		});
		this.addCommand({
			id: "pull-files",
			name: "Pull files",
			callback: () => void this.pullNow(false),
		});
		this.addRibbonIcon("download", "Pull files from Google Cloud Storage", () => void this.pullNow(false));
		this.addSettingTab(new GoogleGcsPullSettingsTab(this.app, this));

		this.registerInterval(window.setInterval(() => void this.runScheduledPull(), 60_000));
	}

	onunload(): void {
		this.unloaded = true;
		this.oauth.cancel();
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	async connectGoogle(): Promise<void> {
		const clientId = this.settings.oauthClientId.trim();
		if (!clientId) throw new Error("Enter an OAuth client ID first.");
		const tokens = await this.oauth.connect(clientId, this.settings.oauthClientSecret.trim());
		this.acceptTokens(tokens);
		await this.saveSettings();
		new Notice("GCS Pull: connected to Google.");
	}

	async disconnectGoogle(): Promise<void> {
		this.settings.refreshToken = "";
		this.access = null;
		await this.saveSettings();
		new Notice("GCS Pull: disconnected from Google.");
	}

	async previewPull(): Promise<PullPlan | null> {
		if (!this.beginOperation()) return null;
		try {
			const scopeKey = this.currentScopeKey();
			const engine = this.createEngine();
			const plan = await engine.preview(this.activeBaseline(scopeKey));
			await this.storePreview(plan);
			new Notice(
				`GCS Pull: ${plan.toPull} file${plan.toPull === 1 ? "" : "s"} to pull ` +
					`(${plan.newFiles} new, ${plan.updatedFiles} updated, ${plan.localEditsToReplace} local edits, ` +
					`${plan.toTrash} to trash, ${plan.backupExpected} backups, ${plan.excluded} excluded).`
			);
			return plan;
		} catch (error) {
			const message = this.message(error);
			this.settings.lastPreview = {
				at: Date.now(),
				scanned: 0,
				excluded: 0,
				toPull: 0,
				newFiles: 0,
				updatedFiles: 0,
				localEditsToReplace: 0,
				toTrash: 0,
				unchanged: 0,
				backupExpected: 0,
				errorCount: 1,
				issues: [{ path: "/", message }],
			};
			await this.saveSettings();
			new Notice(`GCS Pull: ${message}`);
			return null;
		} finally {
			this.operationRunning = false;
		}
	}

	async pullNow(automatic: boolean): Promise<void> {
		if (!this.beginOperation(automatic)) return;
		let progressNotice = automatic ? null : new Notice("GCS Pull: scanning GCS…", 0);
		try {
			const scopeKey = this.currentScopeKey();
			const engine = this.createEngine();
			const plan = await engine.preview(this.activeBaseline(scopeKey));
			await this.storePreview(plan);
			const hasMirrorChanges = plan.localEditsToReplace > 0 || (plan.toTrash > 0 && plan.errorCount === 0);
			if (!automatic && hasMirrorChanges) {
				progressNotice?.hide();
				progressNotice = null;
				if (!(await confirmMirrorPull(this.app, plan))) {
					new Notice("GCS Pull: mirror changes cancelled.");
					return;
				}
				progressNotice = new Notice("GCS Pull: preparing mirror changes…", 0);
			}
			const allowDestructive = !automatic || this.settings.allowDestructiveAutoPull;
			const progressTotal =
				plan.items.filter((item) => item.kind !== "restore" || allowDestructive).length +
				(allowDestructive && plan.errorCount === 0 ? plan.toTrash : 0);
			this.updateProgressNotice(progressNotice, 0, progressTotal);
			const result = await engine.apply(plan, ({ completed, total }) => {
				this.updateProgressNotice(progressNotice, completed, total);
			}, allowDestructive);
			if (this.currentScopeKey() === scopeKey) {
				this.settings.scopeKey = scopeKey;
				this.settings.baseline = result.baseline;
			} else {
				this.settings.scopeKey = "";
				this.settings.baseline = {};
			}
			this.settings.lastRun = {
				at: Date.now(),
				scanned: result.scanned,
				excluded: result.excluded,
				downloadedNew: result.downloadedNew,
				downloadedUpdated: result.downloadedUpdated,
				restoredLocal: result.restoredLocal,
				movedToTrash: result.movedToTrash,
				destructiveDeferred: result.destructiveDeferred,
				alreadyCurrent: result.alreadyCurrent,
				unchanged: result.unchanged,
				backupsCreated: result.backupsCreated,
				errorCount: result.errorCount,
				files: result.files.slice(-50),
				trashedFiles: result.trashedFiles.slice(-50),
				issues: result.issues.slice(0, 20),
			};
			await this.saveSettings();
			if (!automatic || result.errorCount > 0) {
				new Notice(
					`GCS Pull: downloaded ${result.downloadedNew} new and ${result.downloadedUpdated} updated ` +
					`files; restored ${result.restoredLocal}; trashed ${result.movedToTrash}; deferred ` +
					`${result.destructiveDeferred}; ${result.backupsCreated} backups; ${result.errorCount} errors.`
				);
			}
		} catch (error) {
			const message = this.message(error);
			this.settings.lastRun = {
				at: Date.now(),
				scanned: 0,
				excluded: 0,
				downloadedNew: 0,
				downloadedUpdated: 0,
				restoredLocal: 0,
				movedToTrash: 0,
				destructiveDeferred: 0,
				alreadyCurrent: 0,
				unchanged: 0,
				backupsCreated: 0,
				errorCount: 1,
				files: [],
				trashedFiles: [],
				issues: [{ path: "/", message }],
			};
			await this.saveSettings();
			if (!automatic) new Notice(`GCS Pull: ${message}`);
		} finally {
			progressNotice?.hide();
			this.operationRunning = false;
		}
	}

	private async storePreview(plan: PullPlan): Promise<void> {
		this.settings.lastPreview = {
			at: Date.now(),
			scanned: plan.scanned,
			excluded: plan.excluded,
			toPull: plan.toPull,
			newFiles: plan.newFiles,
			updatedFiles: plan.updatedFiles,
			localEditsToReplace: plan.localEditsToReplace,
			toTrash: plan.toTrash,
			unchanged: plan.unchanged,
			backupExpected: plan.backupExpected,
			errorCount: plan.errorCount,
			issues: plan.issues.slice(0, 20),
		};
		await this.saveSettings();
	}

	private createEngine(): PullEngine {
		const bucket = this.settings.bucket.trim();
		if (!bucket) throw new Error("Enter a GCS bucket name.");
		if (!this.settings.refreshToken) throw new Error("Connect to Google first.");
		const remote = new GcsReadClient(obsidianHttp, () => this.getAccessToken(), bucket, this.settings.prefix);
		const local = new ObsidianLocalTarget(this.app, this.settings.destination);
		return new PullEngine(
			remote,
			local,
			() => new Date(),
			() => this.unloaded,
			parseExcludedFolders(this.settings.excludedFolders),
			this.settings.pullMode
		);
	}

	private activeBaseline(scopeKey: string) {
		return this.settings.scopeKey === scopeKey ? this.settings.baseline : {};
	}

	private currentScopeKey(): string {
		return JSON.stringify({
			bucket: this.settings.bucket.trim(),
			prefix: this.settings.prefix.trim().replace(/^\/+|\/+$/g, ""),
			destination: this.settings.destination.trim().replace(/\/+$/g, ""),
		});
	}

	private async getAccessToken(): Promise<string> {
		if (this.access && this.access.expiresAt > Date.now() + 60_000) return this.access.token;
		const clientId = this.settings.oauthClientId.trim();
		if (!clientId || !this.settings.refreshToken) throw new Error("Google OAuth is not configured.");
		const tokens = await this.oauth.refresh(clientId, this.settings.oauthClientSecret.trim(), this.settings.refreshToken);
		this.acceptTokens(tokens);
		await this.saveSettings();
		return tokens.accessToken;
	}

	private acceptTokens(tokens: OAuthTokens): void {
		this.settings.refreshToken = tokens.refreshToken;
		this.access = { token: tokens.accessToken, expiresAt: tokens.expiresAt };
	}

	private beginOperation(quiet = false): boolean {
		if (!this.operationRunning) {
			this.operationRunning = true;
			return true;
		}
		if (!quiet) new Notice("GCS Pull: another operation is already running.");
		return false;
	}

	private async runScheduledPull(): Promise<void> {
		if (!this.settings.autoPull || this.operationRunning || !this.settings.refreshToken) return;
		const interval = Math.max(1, this.settings.autoPullMinutes) * 60_000;
		if (this.settings.lastAutoPullAttempt && Date.now() - this.settings.lastAutoPullAttempt < interval) return;
		this.settings.lastAutoPullAttempt = Date.now();
		await this.saveSettings();
		await this.pullNow(true);
	}

	private message(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	private updateProgressNotice(notice: Notice | null, completed: number, total: number): void {
		if (!notice) return;
		const percent = total === 0 ? 100 : Math.round((completed / total) * 100);
		notice.setMessage(`GCS Pull: applying ${completed}/${total} changes (${percent}%)`);
	}
}
