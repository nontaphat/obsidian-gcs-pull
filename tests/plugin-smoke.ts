import { strict as assert } from "node:assert";
import GoogleGcsPullPlugin from "../src/main";

(globalThis as unknown as { window: unknown }).window = {
	setInterval: () => 7,
	clearInterval: () => undefined,
};

const app = {
	vault: {
		configDir: ".obsidian",
		adapter: {
			exists: async () => false,
			readBinary: async () => new ArrayBuffer(0),
			writeBinary: async () => undefined,
			mkdir: async () => undefined,
		},
	},
};

async function main(): Promise<void> {
	const plugin = new (GoogleGcsPullPlugin as unknown as new (app: unknown) => GoogleGcsPullPlugin & {
		_commands: Array<{ id: string }>;
		_ribbons: string[];
		_settingTabs: Array<{
			getSettingDefinitions(): Array<{ type?: string; heading?: string; items?: unknown[] }>;
			getControlValue(key: string): unknown;
			setControlValue(key: string, value: unknown): Promise<void>;
		}>;
		_intervals: number[];
	})(app);

	await plugin.onload();
	assert.deepEqual(plugin._commands.map((command) => command.id), ["preview-changes", "pull-files"]);
	assert.equal(plugin._ribbons.length, 1);
	assert.equal(plugin._settingTabs.length, 1);
	assert.equal(plugin._intervals.length, 1);

	const tab = plugin._settingTabs[0]!;
	const definitions = tab.getSettingDefinitions();
	assert(definitions.length >= 5);
	assert(definitions.some((group) => group.heading === "Tracking"));
	assert(definitions.every((group) => group.type === "group"));
	assert.equal(tab.getControlValue("destination"), "GCS pull");
	await tab.setControlValue("excludedFolders", " archive/\nprivate/ ");
	assert.equal(plugin.settings.excludedFolders, "archive/\nprivate/");
	await tab.setControlValue("destination", "  Imported notes  ");
	assert.equal(plugin.settings.destination, "Imported notes");
	await tab.setControlValue("autoPullMinutes", 0);
	assert.equal(plugin.settings.autoPullMinutes, 1);

	plugin.onunload();
	console.log("  PASS  plugin lifecycle and declarative settings smoke test");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
