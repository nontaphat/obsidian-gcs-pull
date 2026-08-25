import { App, Modal, Setting } from "obsidian";
import type { PullPlan } from "../pull/types";

interface ConfirmationOptions {
	title: string;
	message: string;
	confirmLabel: string;
}

class ConfirmationModal extends Modal {
	private settled = false;

	constructor(
		app: App,
		private readonly options: ConfirmationOptions,
		private readonly resolve: (confirmed: boolean) => void
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(this.options.title);
		this.contentEl.createEl("p", { text: this.options.message });
		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText("Cancel").onClick(() => this.finish(false)))
			.addButton((button) =>
				button
					.setButtonText(this.options.confirmLabel)
					.setDestructive()
					.onClick(() => this.finish(true))
			);
	}

	onClose(): void {
		if (this.settled) return;
		this.settled = true;
		this.resolve(false);
	}

	private finish(confirmed: boolean): void {
		if (this.settled) return;
		this.settled = true;
		this.resolve(confirmed);
		this.close();
	}
}

function confirm(app: App, options: ConfirmationOptions): Promise<boolean> {
	return new Promise((resolve) => new ConfirmationModal(app, options, resolve).open());
}

export function confirmMirrorMode(app: App): Promise<boolean> {
	return confirm(app, {
		title: "Enable mirror mode?",
		message:
			"GCS will become the source of truth for files previously pulled by this plugin. Local edits may be backed up and replaced, and tracked files removed from GCS may be moved to trash. Local-only and excluded files are not affected.",
		confirmLabel: "Enable mirror mode",
	});
}

export function confirmDestructiveAutoPull(app: App): Promise<boolean> {
	return confirm(app, {
		title: "Allow destructive auto-pull?",
		message:
			"Automatic pulls may replace local edits and move tracked files to trash without asking each time. Obsidian's configured trash behavior will be used.",
		confirmLabel: "Allow automatic changes",
	});
}

export function confirmMirrorPull(app: App, plan: PullPlan): Promise<boolean> {
	const trashCount = plan.errorCount === 0 ? plan.toTrash : 0;
	return confirm(app, {
		title: "Apply mirror changes?",
		message:
			`This pull will replace ${plan.localEditsToReplace} local edit${plan.localEditsToReplace === 1 ? "" : "s"}, ` +
			`move ${trashCount} tracked file${trashCount === 1 ? "" : "s"} to trash, and create up to ` +
			`${plan.backupExpected} conflict backup${plan.backupExpected === 1 ? "" : "s"}.`,
		confirmLabel: "Apply mirror changes",
	});
}
