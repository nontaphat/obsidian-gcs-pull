import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = new URL("..", import.meta.url).pathname;
const temp = mkdtempSync(join(tmpdir(), "gcs-pull-tests-"));
const cases = [
	{ entry: "tests/run.ts", output: "tests.mjs", format: "esm", extra: [] },
	{
		entry: "tests/plugin-smoke.ts",
		output: "plugin-smoke.cjs",
		format: "cjs",
		extra: ["--alias:obsidian=./tests/obsidian-mock.ts"],
	},
];
try {
	for (const testCase of cases) {
		const output = join(temp, testCase.output);
		const build = spawnSync(
			join(root, "node_modules", "esbuild", "bin", "esbuild"),
			[
				testCase.entry,
				"--bundle",
				"--platform=node",
				`--format=${testCase.format}`,
				`--outfile=${output}`,
				...testCase.extra,
			],
			{ cwd: root, stdio: "inherit" }
		);
		if (build.status !== 0) process.exit(build.status ?? 1);
		const run = spawnSync(process.execPath, [output], { cwd: root, stdio: "inherit" });
		if (run.status !== 0) process.exit(run.status ?? 1);
	}
} finally {
	rmSync(temp, { recursive: true, force: true });
}
