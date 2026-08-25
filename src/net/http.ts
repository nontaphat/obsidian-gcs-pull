import { requestUrl } from "obsidian";

export interface HttpRequest {
	method: "GET" | "POST";
	url: string;
	headers?: Record<string, string>;
	body?: string | ArrayBuffer;
}

export interface HttpResponse {
	status: number;
	headers: Record<string, string>;
	text: string;
	arrayBuffer: ArrayBuffer;
}

export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>;

const TIMEOUT_MS = 120_000;

export const obsidianHttp: HttpTransport = async (request) => {
	let timer: number | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = window.setTimeout(() => reject(new Error(`${request.method} request timed out.`)), TIMEOUT_MS);
	});
	try {
		const response = await Promise.race([
			requestUrl({ ...request, throw: false }),
			timeout,
		]);
		return {
			status: response.status,
			headers: response.headers,
			text: response.text,
			arrayBuffer: response.arrayBuffer,
		};
	} finally {
		if (timer !== undefined) window.clearTimeout(timer);
	}
};
