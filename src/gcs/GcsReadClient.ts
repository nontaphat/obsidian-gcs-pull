import { HttpTransport } from "../net/http";

export interface GcsObject {
	objectName: string;
	relativePath: string;
	generation: string;
	size: number;
}

interface ListResponse {
	nextPageToken?: string;
	items?: Array<{ name?: string; generation?: string; size?: string }>;
}

export class GcsReadClient {
	constructor(
		private readonly http: HttpTransport,
		private readonly accessToken: () => Promise<string>,
		private readonly bucket: string,
		private readonly prefix: string
	) {}

	async list(): Promise<GcsObject[]> {
		const objects: GcsObject[] = [];
		const prefix = this.normalizedPrefix();
		let pageToken: string | undefined;
		const seenPageTokens = new Set<string>();
		do {
			if (pageToken) {
				if (seenPageTokens.has(pageToken)) throw new Error("GCS returned a repeated page token.");
				seenPageTokens.add(pageToken);
			}
			const url = new URL(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.bucket)}/o`);
			if (prefix) url.searchParams.set("prefix", prefix);
			if (pageToken) url.searchParams.set("pageToken", pageToken);
			url.searchParams.set("fields", "nextPageToken,items(name,generation,size)");
			const response = await this.http({
				method: "GET",
				url: url.toString(),
				headers: { authorization: `Bearer ${await this.accessToken()}` },
			});
			if (response.status < 200 || response.status >= 300) {
				throw new Error(`GCS list failed (${response.status}): ${response.text.slice(0, 200)}`);
			}
			const parsed = JSON.parse(response.text) as ListResponse;
			for (const item of parsed.items ?? []) {
				if (!item.name || !item.generation || item.name.endsWith("/")) continue;
				const relativePath = prefix && item.name.startsWith(prefix) ? item.name.slice(prefix.length) : item.name;
				if (!relativePath) continue;
				objects.push({
					objectName: item.name,
					relativePath,
					generation: item.generation,
					size: Number(item.size ?? "0"),
				});
			}
			pageToken = parsed.nextPageToken;
		} while (pageToken);
		return objects;
	}

	async download(object: GcsObject): Promise<ArrayBuffer> {
		const url = new URL(
			`https://storage.googleapis.com/download/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(object.objectName)}`
		);
		url.searchParams.set("alt", "media");
		url.searchParams.set("ifGenerationMatch", object.generation);
		const response = await this.http({
			method: "GET",
			url: url.toString(),
			headers: { authorization: `Bearer ${await this.accessToken()}` },
		});
		if (response.status < 200 || response.status >= 300) {
			throw new Error(`GCS download failed (${response.status}).`);
		}
		return response.arrayBuffer;
	}

	private normalizedPrefix(): string {
		const trimmed = this.prefix.trim().replace(/^\/+|\/+$/g, "");
		return trimmed ? `${trimmed}/` : "";
	}
}
