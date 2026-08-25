import type { GcsObject } from "../gcs/GcsReadClient";

export interface FileBaseline {
	generation: string;
	localHash: string;
}

export type PullBaseline = Record<string, FileBaseline>;

export interface PullIssue {
	path: string;
	message: string;
}

export interface PullPlanItem {
	remote: GcsObject;
	destination: string;
	previous?: FileBaseline;
	kind: "new" | "update";
	backupExpected: boolean;
}

export interface PullPlanSummary {
	scanned: number;
	excluded: number;
	toPull: number;
	newFiles: number;
	updatedFiles: number;
	unchanged: number;
	backupExpected: number;
	errorCount: number;
}

export interface PullPlan extends PullPlanSummary {
	items: PullPlanItem[];
	issues: PullIssue[];
	unchangedBaseline: PullBaseline;
}

export interface PullRunSummary {
	scanned: number;
	excluded: number;
	downloadedNew: number;
	downloadedUpdated: number;
	alreadyCurrent: number;
	unchanged: number;
	backupsCreated: number;
	errorCount: number;
	files: string[];
}

export interface PullRunResult extends PullRunSummary {
	issues: PullIssue[];
	baseline: PullBaseline;
}
