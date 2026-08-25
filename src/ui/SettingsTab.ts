import { App, Notice, PluginSettingTab, SettingDefinitionItem } from "obsidian";
import GoogleGcsPullPlugin from "../main";
import { confirmDestructiveAutoPull, confirmMirrorMode } from "./ConfirmModal";

type ControlKey =
	| "oauthClientId"
	| "bucket"
	| "prefix"
	| "excludedFolders"
	| "destination"
	| "pullMode"
	| "autoPull"
	| "autoPullMinutes"
	| "allowDestructiveAutoPull";

export class GoogleGcsPullSettingsTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: GoogleGcsPullPlugin) {
		super(app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem<ControlKey>[] {
		const settings = this.plugin.settings;
		const preview = settings.lastPreview;
		const run = settings.lastRun;
		const issues = run?.issues.length ? run.issues : preview?.issues ?? [];

		return [
			{
				type: "group",
				heading: "Google connection",
				items: [
					{
						name: "OAuth client ID",
						desc: "Client ID from a Google OAuth Desktop application.",
						control: { type: "text", key: "oauthClientId", placeholder: "…apps.googleusercontent.com" },
					},
					{
						name: "OAuth client secret",
						desc: "Stored in this vault's local plugin data.",
						render: (setting) => {
							setting.addText((text) => {
								text.inputEl.type = "password";
								text.setValue(settings.oauthClientSecret).onChange(async (value) => {
									settings.oauthClientSecret = value.trim();
									await this.plugin.saveSettings();
								});
							});
						},
					},
					{
						name: "Connection",
						desc: settings.refreshToken ? "Connected with read-only GCS access." : "Not connected.",
						render: (setting) => {
							setting.addButton((button) =>
								button
									.setButtonText(settings.refreshToken ? "Reconnect" : "Connect")
									.setCta()
									.onClick(() => void this.connect())
							);
							if (settings.refreshToken) {
								setting.addButton((button) =>
									button
										.setButtonText("Disconnect")
										.setDestructive()
										.onClick(() => void this.disconnect())
								);
							}
						},
					},
				],
			},
			{
				type: "group",
				heading: "Source and destination",
				items: [
					{
						name: "GCS bucket",
						desc: "Bucket name without gs://.",
						control: { type: "text", key: "bucket" },
					},
					{
						name: "Object prefix",
						desc: "Optional folder-like prefix. Leave blank to read the whole bucket.",
						control: { type: "text", key: "prefix" },
					},
					{
						name: "Excluded folders",
						desc: "Folder paths relative to the object prefix. Enter one per line or separate them with commas. Matching is case-sensitive.",
						render: (setting) => {
							setting.addTextArea((text) => {
								text
									.setPlaceholder("archive/\nprivate/")
									.setValue(settings.excludedFolders)
									.onChange(async (value) => {
										settings.excludedFolders = value;
										await this.plugin.saveSettings();
									});
							});
						},
					},
					{
						name: "Local destination",
						desc: "Vault-relative folder. Leave blank to use the vault root.",
						control: { type: "text", key: "destination", defaultValue: "GCS pull" },
					},
				],
			},
			{
				type: "group",
				heading: "Pull files",
				items: [
					{
						name: "Pull behavior",
						desc: "Safe pull retains local edits and files. Mirror tracked files uses GCS as the source of truth for files previously pulled by this plugin.",
						control: {
							type: "dropdown",
							key: "pullMode",
							options: { safe: "Safe pull", mirror: "Mirror tracked files" },
						},
					},
					{
						name: "Preview changes",
						desc: "Scan GCS and calculate the exact changes without writing anything.",
						render: (setting) => {
							setting.addButton((button) => button.setButtonText("Preview").onClick(() => void this.preview()));
						},
					},
					{
						name: "Pull from GCS",
						desc: "Scan again, preserve conflicts, then apply the selected pull behavior.",
						render: (setting) => {
							setting.addButton((button) =>
								button
									.setButtonText("Pull from GCS")
									.setCta()
									.onClick(() => void this.pull())
							);
						},
					},
				],
			},
			{
				type: "group",
				heading: "Tracking",
				items: [
					{
						name: "Latest preview",
						desc: preview
							? `${new Date(preview.at).toLocaleString()} · Scanned ${preview.scanned} · Excluded ${preview.excluded ?? 0} · To pull ${preview.toPull} ` +
								`(${preview.newFiles} new, ${preview.updatedFiles} updated, ${preview.localEditsToReplace ?? 0} local edits) · ` +
								`To trash ${preview.toTrash ?? 0} · Unchanged ${preview.unchanged} · ` +
								`Backups expected ${preview.backupExpected} · Errors ${preview.errorCount}`
							: "No preview yet.",
					},
					{
						name: "Latest pull",
						desc: run
							? `${new Date(run.at).toLocaleString()} · Excluded ${run.excluded ?? 0} · Downloaded ${run.downloadedNew} new and ${run.downloadedUpdated} updated · ` +
								`Restored ${run.restoredLocal ?? 0} · Trashed ${run.movedToTrash ?? 0} · Deferred ${run.destructiveDeferred ?? 0} · ` +
								`Already current ${run.alreadyCurrent} · Unchanged ${run.unchanged} · Backups ${run.backupsCreated} · Errors ${run.errorCount}`
							: "No pull yet.",
					},
					{
						name: "Latest downloaded files",
						render: (setting) => {
							this.renderFileList(setting.descEl, run?.files ?? [], "Latest downloaded files");
						},
						visible: () => Boolean(run?.files.length),
					},
					{
						name: "Latest files moved to trash",
						render: (setting) => {
							this.renderFileList(setting.descEl, run?.trashedFiles ?? [], "Latest files moved to trash");
						},
						visible: () => Boolean(run?.trashedFiles?.length),
					},
					{
						name: "Latest issues",
						desc: issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"),
						visible: () => issues.length > 0,
					},
				],
			},
			{
				type: "group",
				heading: "Automation",
				items: [
					{
						name: "Auto-pull",
						desc: "Periodically scan and pull new or updated GCS objects.",
						control: { type: "toggle", key: "autoPull" },
					},
					{
						name: "Auto-pull interval",
						desc: "Minutes between attempts; minimum 1 minute.",
						control: { type: "number", key: "autoPullMinutes", min: 1, step: 1, defaultValue: 15 },
						visible: () => settings.autoPull,
					},
					{
						name: "Allow destructive auto-pull",
						desc: "Automatically replace local edits and move tracked files to trash without asking each time.",
						control: { type: "toggle", key: "allowDestructiveAutoPull" },
						visible: () => settings.autoPull && settings.pullMode === "mirror",
					},
				],
			},
		];
	}

	getControlValue(key: string): unknown {
		if (!this.isControlKey(key)) return undefined;
		return this.plugin.settings[key];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		if (!this.isControlKey(key)) return;
		if (key === "pullMode") {
			const mode = value === "mirror" ? "mirror" : "safe";
			if (mode === "mirror" && this.plugin.settings.pullMode !== "mirror" && !(await confirmMirrorMode(this.app))) {
				this.update();
				return;
			}
			this.plugin.settings.pullMode = mode;
			if (mode === "safe") this.plugin.settings.allowDestructiveAutoPull = false;
		}
		else if (key === "allowDestructiveAutoPull") {
			const enabled = Boolean(value) && this.plugin.settings.pullMode === "mirror";
			if (enabled && !this.plugin.settings.allowDestructiveAutoPull && !(await confirmDestructiveAutoPull(this.app))) {
				this.update();
				return;
			}
			this.plugin.settings.allowDestructiveAutoPull = enabled;
		}
		else if (key === "autoPull") this.plugin.settings.autoPull = Boolean(value);
		else if (key === "autoPullMinutes") {
			const minutes = Number(value);
			this.plugin.settings.autoPullMinutes = Number.isFinite(minutes) ? Math.max(1, minutes) : 15;
		}
		else this.plugin.settings[key] = String(value).trim();
		await this.plugin.saveSettings();
		if (["pullMode", "autoPull", "allowDestructiveAutoPull"].includes(key)) this.update();
	}

	private isControlKey(key: string): key is ControlKey {
		return [
			"oauthClientId",
			"bucket",
			"prefix",
			"excludedFolders",
			"destination",
			"pullMode",
			"autoPull",
			"autoPullMinutes",
			"allowDestructiveAutoPull",
		].includes(key);
	}

	private renderFileList(container: HTMLElement, files: string[], label: string): void {
		const list = container.createDiv({ cls: "gcs-pull-file-list" });
		list.tabIndex = 0;
		list.setAttribute("role", "list");
		list.setAttribute("aria-label", label);
		for (const file of files) {
			const row = list.createDiv({ cls: "gcs-pull-file-row", text: file });
			row.setAttribute("role", "listitem");
			row.title = file;
		}
	}

	private async connect(): Promise<void> {
		try {
			await this.plugin.connectGoogle();
			this.update();
		} catch (error) {
			new Notice(`GCS Pull: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async disconnect(): Promise<void> {
		await this.plugin.disconnectGoogle();
		this.update();
	}

	private async preview(): Promise<void> {
		await this.plugin.previewPull();
		this.update();
	}

	private async pull(): Promise<void> {
		await this.plugin.pullNow(false);
		this.update();
	}
}
