export interface App {
	vault: Record<string, unknown>;
}

export class Notice {
	constructor(_message: string, _duration?: number) {}

	setMessage(_message: string): this {
		return this;
	}

	hide(): void {}
}

export class Plugin {
	app: App;
	_commands: Array<{ id: string; name: string }> = [];
	_ribbons: string[] = [];
	_settingTabs: unknown[] = [];
	_intervals: number[] = [];
	_savedData: unknown = null;

	constructor(app: App) {
		this.app = app;
	}

	loadData(): Promise<unknown> {
		return Promise.resolve(null);
	}

	saveData(data: unknown): Promise<void> {
		this._savedData = data;
		return Promise.resolve();
	}

	addCommand(command: { id: string; name: string }): void {
		this._commands.push(command);
	}

	addRibbonIcon(icon: string): void {
		this._ribbons.push(icon);
	}

	addSettingTab(tab: unknown): void {
		this._settingTabs.push(tab);
	}

	registerInterval(id: number): number {
		this._intervals.push(id);
		return id;
	}
}

export class PluginSettingTab {
	app: App;
	plugin: Plugin;
	updates = 0;

	constructor(app: App, plugin: Plugin) {
		this.app = app;
		this.plugin = plugin;
	}

	update(): void {
		this.updates += 1;
	}
}

export function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
}

export function requestUrl(): Promise<never> {
	return Promise.reject(new Error("Network is not available in the smoke test."));
}
