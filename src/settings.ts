import { PullBaseline, PullIssue, PullPlanSummary, PullRunSummary } from "./pull/types";

export interface PluginSettings {
	bucket: string;
	prefix: string;
	excludedFolders: string;
	destination: string;
	oauthClientId: string;
	oauthClientSecret: string;
	refreshToken: string;
	autoPull: boolean;
	autoPullMinutes: number;
	scopeKey: string;
	baseline: PullBaseline;
	lastPreview: (PullPlanSummary & { at: number; issues: PullIssue[] }) | null;
	lastRun: (PullRunSummary & { at: number; issues: PullIssue[] }) | null;
	lastAutoPullAttempt: number | null;
}

export const DEFAULT_SETTINGS: PluginSettings = {
	bucket: "",
	prefix: "",
	excludedFolders: "",
	destination: "GCS pull",
	oauthClientId: "",
	oauthClientSecret: "",
	refreshToken: "",
	autoPull: false,
	autoPullMinutes: 15,
	scopeKey: "",
	baseline: {},
	lastPreview: null,
	lastRun: null,
	lastAutoPullAttempt: null,
};

export function loadSettings(data: unknown): PluginSettings {
	const source = data && typeof data === "object" ? (data as Partial<PluginSettings>) : {};
	return {
		...DEFAULT_SETTINGS,
		...source,
		excludedFolders: typeof source.excludedFolders === "string" ? source.excludedFolders : "",
		autoPullMinutes: Number.isFinite(source.autoPullMinutes) ? Math.max(1, Number(source.autoPullMinutes)) : 15,
		baseline: source.baseline && typeof source.baseline === "object" ? { ...source.baseline } : {},
	};
}
