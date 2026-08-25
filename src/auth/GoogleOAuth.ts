import { HttpTransport } from "../net/http";

interface NodeRequest {
	url?: string;
}

interface NodeResponse {
	writeHead(status: number, headers?: Record<string, string>): void;
	end(body?: string): void;
}

interface NodeServer {
	listen(port: number, host: string, callback: () => void): void;
	close(): void;
	address(): { port: number } | null;
	on(event: "error", callback: (error: Error) => void): void;
}

interface HttpModule {
	createServer(handler: (request: NodeRequest, response: NodeResponse) => void): NodeServer;
}

interface ElectronModule {
	shell?: { openExternal?: (url: string) => Promise<void> };
}

interface TokenResponse {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
}

export interface OAuthTokens {
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
}

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const READ_ONLY_SCOPE = "https://www.googleapis.com/auth/devstorage.read_only";

function rendererRequire<T>(moduleName: string): T {
	const requireFn = (window as unknown as { require?: (name: string) => unknown }).require;
	if (!requireFn) throw new Error("Google sign-in requires Obsidian desktop.");
	return requireFn(moduleName) as T;
}

function base64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomValue(byteLength: number): string {
	return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function challengeFor(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return base64Url(new Uint8Array(digest));
}

function formBody(values: Record<string, string>): string {
	return new URLSearchParams(values).toString();
}

async function parseTokens(responseText: string, fallbackRefreshToken?: string): Promise<OAuthTokens> {
	const parsed = JSON.parse(responseText) as TokenResponse;
	if (!parsed.access_token) throw new Error("Google did not return an access token.");
	const refreshToken = parsed.refresh_token ?? fallbackRefreshToken;
	if (!refreshToken) throw new Error("Google did not return a refresh token. Revoke access and connect again.");
	return {
		accessToken: parsed.access_token,
		refreshToken,
		expiresAt: Date.now() + Math.max(60, parsed.expires_in ?? 3600) * 1000,
	};
}

async function tokenRequest(http: HttpTransport, values: Record<string, string>, fallbackRefreshToken?: string): Promise<OAuthTokens> {
	const response = await http({
		method: "POST",
		url: TOKEN_URL,
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: formBody(values),
	});
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`Google token request failed (${response.status}): ${response.text.slice(0, 160)}`);
	}
	return parseTokens(response.text, fallbackRefreshToken);
}

export class GoogleOAuth {
	private cancelLogin: ((reason: Error) => void) | null = null;

	constructor(private readonly http: HttpTransport) {}

	async connect(clientId: string, clientSecret: string): Promise<OAuthTokens> {
		if (this.cancelLogin) throw new Error("A Google sign-in is already running.");
		const verifier = randomValue(32);
		const expectedState = randomValue(24);
		const challenge = await challengeFor(verifier);
		const httpModule = rendererRequire<HttpModule>("http");

		return new Promise<OAuthTokens>((resolve, reject) => {
			const server = httpModule.createServer((request, response) => {
				void handleCallback(request, response);
			});
			let timer: number | undefined;
			let settled = false;
			let callbackAccepted = false;

			const cleanup = (): void => {
				if (timer !== undefined) window.clearTimeout(timer);
				try {
					server.close();
				} catch {
					// The server may not have started listening yet.
				}
				this.cancelLogin = null;
			};

			const fail = (error: Error): void => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			};

			const succeed = (tokens: OAuthTokens): void => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(tokens);
			};

			const handleCallback = async (request: NodeRequest, response: NodeResponse): Promise<void> => {
				if (settled || callbackAccepted || !request.url) {
					response.writeHead(400);
					response.end();
					return;
				}
				const callback = new URL(request.url, "http://127.0.0.1");
				if (callback.pathname !== "/callback") {
					response.writeHead(404);
					response.end();
					return;
				}
				if (callback.searchParams.get("state") !== expectedState) {
					response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
					response.end("Invalid OAuth state. Return to Obsidian and try again.");
					fail(new Error("Google sign-in returned an invalid OAuth state."));
					return;
				}
				const authError = callback.searchParams.get("error");
				const code = callback.searchParams.get("code");
				if (authError || !code) {
					response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
					response.end("Google sign-in was not completed.");
					fail(new Error(`Google sign-in failed: ${authError ?? "authorization code missing"}.`));
					return;
				}

				callbackAccepted = true;
				const port = server.address()?.port;
				try {
					server.close();
				} catch {
					// Cleanup below remains idempotent.
				}
				response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
				response.end("<!doctype html><meta charset=\"utf-8\"><title>Authorized</title><p>Authorization received. You can close this tab and return to Obsidian.</p>");
				try {
					if (!port) throw new Error("OAuth callback server is no longer available.");
					const tokens = await tokenRequest(this.http, {
						client_id: clientId,
						...(clientSecret ? { client_secret: clientSecret } : {}),
						code,
						code_verifier: verifier,
						redirect_uri: `http://127.0.0.1:${port}/callback`,
						grant_type: "authorization_code",
					});
					succeed(tokens);
				} catch (error) {
					fail(error instanceof Error ? error : new Error(String(error)));
				}
			};

			server.on("error", fail);
			this.cancelLogin = fail;
			timer = window.setTimeout(() => fail(new Error("Google sign-in timed out after five minutes.")), 5 * 60_000);
			server.listen(0, "127.0.0.1", () => {
				const port = server.address()?.port;
				if (!port) {
					fail(new Error("Could not start the OAuth callback server."));
					return;
				}
				const authUrl = new URL(AUTH_URL);
				authUrl.searchParams.set("client_id", clientId);
				authUrl.searchParams.set("redirect_uri", `http://127.0.0.1:${port}/callback`);
				authUrl.searchParams.set("response_type", "code");
				authUrl.searchParams.set("scope", READ_ONLY_SCOPE);
				authUrl.searchParams.set("code_challenge", challenge);
				authUrl.searchParams.set("code_challenge_method", "S256");
				authUrl.searchParams.set("state", expectedState);
				authUrl.searchParams.set("access_type", "offline");
				authUrl.searchParams.set("prompt", "consent");
				this.openBrowser(authUrl.toString()).catch(fail);
			});
		});
	}

	refresh(clientId: string, clientSecret: string, refreshToken: string): Promise<OAuthTokens> {
		return tokenRequest(
			this.http,
			{
				client_id: clientId,
				...(clientSecret ? { client_secret: clientSecret } : {}),
				refresh_token: refreshToken,
				grant_type: "refresh_token",
			},
			refreshToken
		);
	}

	cancel(): void {
		this.cancelLogin?.(new Error("Google sign-in was cancelled because the plugin unloaded."));
	}

	private async openBrowser(url: string): Promise<void> {
		const electron = rendererRequire<ElectronModule>("electron");
		if (!electron.shell?.openExternal) throw new Error("Could not open the system browser.");
		await electron.shell.openExternal(url);
	}
}
