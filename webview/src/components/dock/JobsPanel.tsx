import React, { useEffect, useState } from "react";
import type { ChatViewState } from "../../../../src/types";
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
            <div className="dsh-card-detail">{t("Job Center · read-only")}</div>
            {jobs.map((job) => (
                <div className="dsh-job-row" key={job.id}>
                    <div className="dsh-job-label">{job.label}</div>
                    <div className="dsh-job-meta">
                        {job.kind} · {job.status} · {job.id} · {formatJobDuration((job.finishedAt ?? now) - job.startedAt)}
                    </div>
                    <div className="dsh-job-owner">{t("owner {owner}", { owner: job.ownerSessionId })}</div>
                    {job.outputSummary ? <div className="dsh-job-summary">{job.outputSummary}</div> : null}
                </div>
            ))}
        </div>
    );
}
