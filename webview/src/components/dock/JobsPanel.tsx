import React, { useEffect, useState } from "react";
import type { ChatViewState } from "../../../../src/types";
import { postAction } from "../../bridge";
import { t } from "../../i18n";

function isLiveJob(job: ChatViewState["jobs"][number]): boolean {
    return job.status === "running" || job.status === "stopping";
}

function formatJobDuration(milliseconds: number): string {
    const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
    const seconds = totalSeconds % 60;
    const minutes = Math.floor(totalSeconds / 60) % 60;
    const hours = Math.floor(totalSeconds / 3_600);
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
}

export function JobsPanel({ jobs }: { jobs: ChatViewState["jobs"] }): React.JSX.Element {
    const [now, setNow] = useState(() => Date.now());
    const hasLiveJob = jobs.some(isLiveJob);
    useEffect(() => {
        if (!hasLiveJob) return;
        const timer = window.setInterval(() => setNow(Date.now()), 1_000);
        return () => window.clearInterval(timer);
    }, [hasLiveJob]);
    return (
        <div>
            <div className="dsh-card-detail">{t("Job Center · live output")}</div>
            {jobs.map((job) => (
                <div className="dsh-job-row" key={job.id}>
                    <div className="dsh-job-label">{job.label}</div>
                    <div className="dsh-job-meta">
                        {job.kind} · {t(({ running: "Running", stopping: "Stopping...", completed: "Completed", killed: "Cancelled", failed: "Failed" })[job.status])} · {job.id} · {formatJobDuration((job.finishedAt ?? now) - job.startedAt)}
                        {job.progress ? ` · ${job.progress}` : ""}
                    </div>
                    <div className="dsh-job-owner">{job.ownerSessionId ? t("owner {owner}", { owner: job.ownerSessionId }) : t("Unowned job")}</div>
                    {job.outputSummary ? <div className="dsh-job-summary">{job.outputSummary}</div> : null}
                    {job.streamError ? <div className="dsh-card-error">{job.streamError}</div> : null}
                    {job.outputText ? <pre tabIndex={0} className="dsh-job-output">{job.outputGap ? "… " : ""}{job.outputText}</pre> : null}
                    {job.canKill ? (
                        <button
                            type="button"
                            className="dsh-button dsh-button-secondary"
                            onClick={() => postAction({ type: "killJob", jobId: job.id })}
                        >
                            {job.status === "stopping" ? t("Stopping...") : t("Cancel job")}
                        </button>
                    ) : null}
                </div>
            ))}
        </div>
    );
}
