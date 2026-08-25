import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig(
	globalIgnores(["node_modules", "main.js", "esbuild.config.mjs", "tests/run-tests.mjs"]),
	{
		languageOptions: {
			globals: { ...globals.browser, ...globals.node },
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		files: ["src/main.ts", "src/ui/**/*.ts"],
		rules: {
			"obsidianmd/settings-tab/prefer-setting-definitions": "off",
			"obsidianmd/settings-tab/prefer-update-over-display": "off",
			"obsidianmd/ui/sentence-case": "off"
		}
	},
	{
		files: ["tests/**/*.ts"],
		rules: {
			"obsidianmd/no-static-styles-assignment": "off",
			"obsidianmd/rule-custom-message": "off",
			"obsidianmd/hardcoded-config-path": "off",
			"obsidianmd/no-global-this": "off"
		}
	}
);
