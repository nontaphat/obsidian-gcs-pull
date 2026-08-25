import { strict as assert } from "node:assert";
import { GcsObject, GcsReadClient } from "../src/gcs/GcsReadClient";
import { LocalTarget } from "../src/local/LocalTarget";
import { HttpResponse, HttpTransport } from "../src/net/http";
import { PullEngine, RemoteReader } from "../src/pull/PullEngine";
import { isExcludedPath, parseExcludedFolders } from "../src/pull/exclusions";
import { joinVaultPath, safeRemotePath } from "../src/safety/paths";

const encode = (value: string): ArrayBuffer => new TextEncoder().encode(value).buffer;
const decode = (value: ArrayBuffer): string => new TextDecoder().decode(value);

let passed = 0;
async function test(name: string, run: () => void | Promise<void>): Promise<void> {
	try {
		await run();
		passed += 1;
		console.log(`  PASS  ${name}`);
	} catch (error) {
		console.error(`  FAIL  ${name}`);
		throw error;
	}
}

function response(status: number, body: string): HttpResponse {
	return { status, headers: {}, text: body, arrayBuffer: encode(body) };
}

class FakeRemote implements RemoteReader {
	objects = new Map<string, { generation: number; data: ArrayBuffer }>();
	downloads: string[] = [];

	list(): Promise<GcsObject[]> {
		return Promise.resolve(
			[...this.objects].map(([relativePath, value]) => ({
				objectName: relativePath,
				relativePath,
				generation: String(value.generation),
				size: value.data.byteLength,
			}))
		);
	}

	download(object: GcsObject): Promise<ArrayBuffer> {
		this.downloads.push(object.relativePath);
		const found = this.objects.get(object.relativePath);
		if (!found || String(found.generation) !== object.generation) throw new Error("generation changed");
		return Promise.resolve(found.data);
	}

	set(path: string, content: string, generation: number): void {
		this.objects.set(path, { generation, data: encode(content) });
	}
}

class FakeLocal implements LocalTarget {
	files = new Map<string, ArrayBuffer>();
	writes: string[] = [];
	backups: string[] = [];
	trashed: string[] = [];
	trashFailures = new Set<string>();

	resolve(remotePath: string): { path: string; collisionKey: string } {
		const safe = safeRemotePath(remotePath);
		return { path: safe.relative, collisionKey: safe.collisionKey };
	}

	exists(path: string): Promise<boolean> {
		return Promise.resolve(this.files.has(path));
	}

	read(path: string): Promise<ArrayBuffer> {
		const value = this.files.get(path);
		if (!value) throw new Error(`missing local file: ${path}`);
		return Promise.resolve(value);
	}

	write(path: string, data: ArrayBuffer): Promise<void> {
		this.writes.push(path);
		this.files.set(path, data);
		return Promise.resolve();
	}

	backup(path: string, data: ArrayBuffer): Promise<string> {
		const backupPath = `${path}.backup-${this.backups.length + 1}`;
		this.backups.push(backupPath);
		this.files.set(backupPath, data);
		return Promise.resolve(backupPath);
	}

	trash(path: string): Promise<void> {
		if (this.trashFailures.has(path)) return Promise.reject(new Error(`Cannot trash ${path}`));
		this.trashed.push(path);
		this.files.delete(path);
		return Promise.resolve();
	}
}

await test("GCS JSON pagination preserves special object names and page tokens", async () => {
	const calls: URL[] = [];
	const http: HttpTransport = async (request) => {
		const url = new URL(request.url);
		calls.push(url);
		if (!url.searchParams.get("pageToken")) {
			return response(
				200,
				JSON.stringify({
					nextPageToken: "token&A=1",
					items: [{ name: "folder/A&B.md", generation: "10", size: "4" }],
				})
			);
		}
		return response(200, JSON.stringify({ items: [{ name: "folder/deep/ก.md", generation: "11", size: "5" }] }));
	};
	const client = new GcsReadClient(http, async () => "token", "bucket", "folder");
	const objects = await client.list();
	assert.deepEqual(objects.map((item) => item.relativePath), ["A&B.md", "deep/ก.md"]);
	assert.equal(calls[1]?.searchParams.get("pageToken"), "token&A=1");
});

await test("GCS downloads pin the generation and encode the complete object name", async () => {
	let called: URL | null = null;
	const http: HttpTransport = async (request) => {
		called = new URL(request.url);
		return { status: 200, headers: {}, text: "", arrayBuffer: encode("data") };
	};
	const client = new GcsReadClient(http, async () => "token", "bucket", "folder");
	const data = await client.download({ objectName: "folder/A&B.md", relativePath: "A&B.md", generation: "42", size: 4 });
	assert.equal(decode(data), "data");
	assert.equal((called as URL | null)?.searchParams.get("ifGenerationMatch"), "42");
	assert((called as URL | null)?.pathname.endsWith("folder%2FA%26B.md"));
});

await test("path safety blocks config-directory case aliases, traversal, and backslashes", () => {
	assert.throws(() => joinVaultPath("", ".OBSIDIAN/plugins/evil.js", ".obsidian"));
	assert.throws(() => safeRemotePath("../evil.md"));
	assert.throws(() => safeRemotePath("a\\b.md"));
	assert.throws(() => safeRemotePath("a//b.md"));
});

await test("excluded folders accept lines and commas and match descendants only", () => {
	const folders = parseExcludedFolders(" archive/\nprivate, archive/old ");
	assert.deepEqual(folders, ["archive", "private"]);
	assert(isExcludedPath("archive/a.md", folders));
	assert(isExcludedPath("private/deep/b.md", folders));
	assert(!isExcludedPath("archive.md", folders));
	assert(!isExcludedPath("Archive/a.md", folders));
	assert.throws(() => parseExcludedFolders("../private"));
});

await test("preview and pull skip excluded folders while retaining their baseline", async () => {
	const remote = new FakeRemote();
	remote.set("keep.md", "keep", 1);
	remote.set("archive/a.md", "a", 1);
	remote.set("archive/deep/b.md", "b", 1);
	const local = new FakeLocal();
	const prior = { generation: "1", localHash: "prior-hash" };
	const engine = new PullEngine(remote, local, () => new Date(), () => false, ["archive"]);
	const plan = await engine.preview({ "archive/a.md": prior });
	assert.deepEqual(
		{ scanned: plan.scanned, excluded: plan.excluded, toPull: plan.toPull },
		{ scanned: 3, excluded: 2, toPull: 1 }
	);
	const result = await engine.apply(plan);
	assert.deepEqual(remote.downloads, ["keep.md"]);
	assert.deepEqual(result.baseline["archive/a.md"], prior);
});

await test("preview rejects case-insensitive local path collisions", async () => {
	const remote = new FakeRemote();
	remote.set("A.md", "A", 1);
	remote.set("a.md", "a", 1);
	const plan = await new PullEngine(remote, new FakeLocal()).preview({});
	assert.equal(plan.toPull, 0);
	assert.equal(plan.errorCount, 2);
});

await test("initial pull downloads new files and retains local-only files", async () => {
	const remote = new FakeRemote();
	remote.set("a.md", "remote-a", 1);
	remote.set("deep/b.md", "remote-b", 1);
	const local = new FakeLocal();
	local.files.set("local-only.md", encode("keep"));
	const engine = new PullEngine(remote, local);
	const plan = await engine.preview({});
	assert.deepEqual(
		{ scanned: plan.scanned, toPull: plan.toPull, newFiles: plan.newFiles, updatedFiles: plan.updatedFiles },
		{ scanned: 2, toPull: 2, newFiles: 2, updatedFiles: 0 }
	);
	const result = await engine.apply(plan);
	assert.equal(result.downloadedNew, 2);
	assert.equal(decode(local.files.get("local-only.md")!), "keep");
	assert.equal(decode(local.files.get("deep/b.md")!), "remote-b");
});

await test("pull progress reports every planned file through 100 percent", async () => {
	const remote = new FakeRemote();
	remote.set("a.md", "a", 1);
	remote.set("b.md", "b", 1);
	const engine = new PullEngine(remote, new FakeLocal());
	const plan = await engine.preview({});
	const progress: Array<{ completed: number; total: number }> = [];
	await engine.apply(plan, (update) => progress.push(update));
	assert.deepEqual(progress, [
		{ completed: 1, total: 2 },
		{ completed: 2, total: 2 },
	]);
});

await test("a local edit is retained while the remote generation is unchanged", async () => {
	const remote = new FakeRemote();
	remote.set("a.md", "remote-a", 1);
	const local = new FakeLocal();
	const engine = new PullEngine(remote, local);
	const first = await engine.apply(await engine.preview({}));
	local.files.set("a.md", encode("local edit"));
	local.writes.length = 0;
	const plan = await engine.preview(first.baseline);
	const second = await engine.apply(plan);
	assert.equal(plan.toPull, 0);
	assert.equal(second.unchanged, 1);
	assert.equal(decode(local.files.get("a.md")!), "local edit");
	assert.equal(local.writes.length, 0);
});

await test("mirror mode backs up and restores a local edit when the remote generation is unchanged", async () => {
	const remote = new FakeRemote();
	remote.set("a.md", "remote-a", 1);
	const local = new FakeLocal();
	const safe = new PullEngine(remote, local);
	const first = await safe.apply(await safe.preview({}));
	local.files.set("a.md", encode("local edit"));
	const mirror = new PullEngine(remote, local, () => new Date(), () => false, [], "mirror");
	const plan = await mirror.preview(first.baseline);
	assert.equal(plan.localEditsToReplace, 1);
	assert.equal(plan.backupExpected, 1);
	const result = await mirror.apply(plan);
	assert.equal(result.restoredLocal, 1);
	assert.equal(result.backupsCreated, 1);
	assert.equal(decode(local.files.get("a.md")!), "remote-a");
	assert.equal(decode(local.files.get(local.backups[0]!)!), "local edit");
});

await test("a remote-only update overwrites without creating a conflict backup", async () => {
	const remote = new FakeRemote();
	remote.set("a.md", "v1", 1);
	const local = new FakeLocal();
	const engine = new PullEngine(remote, local);
	const first = await engine.apply(await engine.preview({}));
	remote.set("a.md", "v2", 2);
	const plan = await engine.preview(first.baseline);
	assert.equal(plan.updatedFiles, 1);
	assert.equal(plan.backupExpected, 0);
	const second = await engine.apply(plan);
	assert.equal(second.downloadedUpdated, 1);
	assert.equal(second.backupsCreated, 0);
	assert.equal(decode(local.files.get("a.md")!), "v2");
});

await test("concurrent local and remote edits preserve local content before overwrite", async () => {
	const remote = new FakeRemote();
	remote.set("a.md", "v1", 1);
	const local = new FakeLocal();
	const engine = new PullEngine(remote, local, () => new Date("2026-08-25T01:02:03.456Z"));
	const first = await engine.apply(await engine.preview({}));
	local.files.set("a.md", encode("local edit"));
	remote.set("a.md", "remote edit", 2);
	const plan = await engine.preview(first.baseline);
	assert.equal(plan.backupExpected, 1);
	const second = await engine.apply(plan);
	assert.equal(second.backupsCreated, 1);
	assert.equal(decode(local.files.get("a.md")!), "remote edit");
	assert.equal(decode(local.files.get(local.backups[0]!)!), "local edit");
});

await test("remote deletion never deletes the retained local file or baseline of other files", async () => {
	const remote = new FakeRemote();
	remote.set("a.md", "a", 1);
	remote.set("b.md", "b", 1);
	const local = new FakeLocal();
	const engine = new PullEngine(remote, local);
	const first = await engine.apply(await engine.preview({}));
	remote.objects.delete("b.md");
	const second = await engine.apply(await engine.preview(first.baseline));
	assert(local.files.has("b.md"));
	assert(second.baseline["a.md"]);
	assert.equal(second.baseline["b.md"], undefined);
});

await test("mirror mode trashes only previously tracked files removed from GCS", async () => {
	const remote = new FakeRemote();
	remote.set("tracked.md", "tracked", 1);
	const local = new FakeLocal();
	local.files.set("local-only.md", encode("keep"));
	const safe = new PullEngine(remote, local);
	const first = await safe.apply(await safe.preview({}));
	remote.objects.delete("tracked.md");
	const mirror = new PullEngine(remote, local, () => new Date(), () => false, [], "mirror");
	const plan = await mirror.preview(first.baseline);
	assert.equal(plan.toTrash, 1);
	const result = await mirror.apply(plan);
	assert.equal(result.movedToTrash, 1);
	assert.deepEqual(local.trashed, ["tracked.md"]);
	assert(!local.files.has("tracked.md"));
	assert(local.files.has("local-only.md"));
	assert.equal(result.baseline["tracked.md"], undefined);
});

await test("mirror changes can be deferred for automatic pulls", async () => {
	const remote = new FakeRemote();
	remote.set("edited.md", "remote", 1);
	remote.set("deleted.md", "delete me", 1);
	const local = new FakeLocal();
	const safe = new PullEngine(remote, local);
	const first = await safe.apply(await safe.preview({}));
	local.files.set("edited.md", encode("local edit"));
	remote.objects.delete("deleted.md");
	remote.downloads.length = 0;
	const mirror = new PullEngine(remote, local, () => new Date(), () => false, [], "mirror");
	const plan = await mirror.preview(first.baseline);
	const result = await mirror.apply(plan, undefined, false);
	assert.equal(result.destructiveDeferred, 2);
	assert.equal(decode(local.files.get("edited.md")!), "local edit");
	assert(local.files.has("deleted.md"));
	assert.equal(local.trashed.length, 0);
	assert.equal(remote.downloads.length, 0);
	assert(result.baseline["edited.md"]);
	assert(result.baseline["deleted.md"]);
});

await test("mirror mode blocks trash when preview contains path errors", async () => {
	const remote = new FakeRemote();
	remote.set("tracked.md", "tracked", 1);
	const local = new FakeLocal();
	const safe = new PullEngine(remote, local);
	const first = await safe.apply(await safe.preview({}));
	remote.objects.delete("tracked.md");
	remote.set("bad//path.md", "bad", 1);
	const mirror = new PullEngine(remote, local, () => new Date(), () => false, [], "mirror");
	const plan = await mirror.preview(first.baseline);
	assert.equal(plan.errorCount, 1);
	assert.equal(plan.toTrash, 1);
	const result = await mirror.apply(plan);
	assert.equal(result.movedToTrash, 0);
	assert.equal(result.destructiveDeferred, 1);
	assert(local.files.has("tracked.md"));
	assert(result.baseline["tracked.md"]);
});

await test("mirror mode retains excluded tracked files", async () => {
	const local = new FakeLocal();
	local.files.set("archive/a.md", encode("keep"));
	const prior = { generation: "1", localHash: "hash" };
	const mirror = new PullEngine(new FakeRemote(), local, () => new Date(), () => false, ["archive"], "mirror");
	const plan = await mirror.preview({ "archive/a.md": prior });
	assert.equal(plan.toTrash, 0);
	const result = await mirror.apply(plan);
	assert(local.files.has("archive/a.md"));
	assert.deepEqual(result.baseline["archive/a.md"], prior);
});

await test("mirror mode stops after a trash failure and retains pending baselines", async () => {
	const local = new FakeLocal();
	local.files.set("a.md", encode("a"));
	local.files.set("b.md", encode("b"));
	local.trashFailures.add("a.md");
	const prior = {
		"a.md": { generation: "1", localHash: "a-hash" },
		"b.md": { generation: "1", localHash: "b-hash" },
	};
	const mirror = new PullEngine(new FakeRemote(), local, () => new Date(), () => false, [], "mirror");
	const result = await mirror.apply(await mirror.preview(prior));
	assert.equal(result.movedToTrash, 0);
	assert.equal(result.destructiveDeferred, 2);
	assert.equal(result.errorCount, 1);
	assert(local.files.has("a.md"));
	assert(local.files.has("b.md"));
	assert.deepEqual(result.baseline, prior);
});

await test("error totals are not truncated", async () => {
	const remote = new FakeRemote();
	for (let index = 0; index < 25; index += 1) remote.set(`bad//${index}.md`, "x", 1);
	const plan = await new PullEngine(remote, new FakeLocal()).preview({});
	assert.equal(plan.errorCount, 25);
	assert.equal(plan.issues.length, 25);
});

console.log(`\n${passed} focused pull-only tests passed.`);
