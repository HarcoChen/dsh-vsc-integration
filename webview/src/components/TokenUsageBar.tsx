import React, { useEffect, useRef, useState } from "react";
import type { TokenUsageView } from "../../../src/types";
import { CloseIcon } from "./icons";

interface TokenUsageBarProps {
    usage: TokenUsageView | undefined;
}

interface RingProps {
    percent: number | undefined;
    size: "small" | "large";
    severity: "normal" | "warning" | "critical";
}

interface ChartRowProps {
    label: string;
    tokens: number | undefined;
    maximum: number;
    kind: "input" | "output" | "reasoning" | "cache-read" | "cache-write";
    suffix?: string;
    title: string;
}

const formatter = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });

function compactTokens(tokens: number): string {
    if (tokens < 1_000) return formatter.format(tokens);
    if (tokens < 1_000_000) return `${formatter.format(tokens / 1_000)}K`;
    return `${formatter.format(tokens / 1_000_000)}M`;
}

function UsageRing({ percent, size, severity }: RingProps): React.JSX.Element {
    const progress = Math.min(100, Math.max(0, percent ?? 0));
    return (
        <span className={`dsh-usage-ring ${size} ${severity}`} aria-hidden="true">
            <svg viewBox="0 0 36 36">
                <circle className="track" cx="18" cy="18" r="14.5" pathLength="100" />
                <circle
                    className="progress"
                    cx="18"
                    cy="18"
                    r="14.5"
                    pathLength="100"
                    strokeDasharray={`${progress} 100`}
                />
            </svg>
            <span>{percent === undefined ? "--" : `${Math.round(percent)}%`}</span>
        </span>
    );
}

function ChartRow({
    label,
    tokens,
    maximum,
    kind,
    suffix,
    title,
}: ChartRowProps): React.JSX.Element {
    const width = tokens === undefined
        ? 0
        : Math.min(100, Math.max(2, (tokens / maximum) * 100));
    return (
        <div className="dsh-token-chart-row" title={title}>
            <span className="dsh-token-chart-label">{label}</span>
            <span className="dsh-token-chart-track">
                <span className={`dsh-token-chart-fill ${kind}`} style={{ width: `${width}%` }} />
            </span>
            <span className="dsh-token-chart-value">
                {tokens === undefined ? "--" : compactTokens(tokens)}
                {suffix ? <small>{suffix}</small> : null}
            </span>
        </div>
    );
}

export function TokenUsageBar({ usage }: TokenUsageBarProps): React.JSX.Element | null {
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLElement>(null);

    useEffect(() => {
        if (!open) return;
        const onPointerDown = (event: MouseEvent): void => {
            if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
                setOpen(false);
            }
        };
        const onEscape = (event: KeyboardEvent): void => {
            if (event.key === "Escape") setOpen(false);
        };
        document.addEventListener("mousedown", onPointerDown);
        document.addEventListener("keydown", onEscape);
        return () => {
            document.removeEventListener("mousedown", onPointerDown);
            document.removeEventListener("keydown", onEscape);
        };
    }, [open]);

    if (!usage) return null;
    const { route, billing, context } = usage;
    const routeLabel = route.model || "模型未知";
    const occupied = context?.projectedTokens;
    const capacity = context?.contextWindow;
    const occupancy = occupied !== undefined && capacity !== undefined
        ? (occupied / capacity) * 100
        : undefined;
    const severity = occupancy !== undefined && occupancy >= 95
        ? "critical"
        : occupancy !== undefined && occupancy >= 80
          ? "warning"
          : "normal";
    const promptTraffic = billing
        ? billing.uncachedInputTokens + billing.cacheReadTokens + billing.cacheWriteTokens
        : 0;
    const cacheHitRate = billing && promptTraffic > 0
        ? (billing.cacheReadTokens / promptTraffic) * 100
        : undefined;
    const chartMaximum = billing
        ? Math.max(
              1,
              billing.uncachedInputTokens,
              billing.outputTokens,
              billing.cacheReadTokens,
              billing.cacheWriteTokens,
          )
        : 1;

    return (
        <section className="dsh-usage" aria-label="Token 与上下文用量" ref={rootRef}>
            <button
                type="button"
                className="dsh-usage-summary"
                aria-expanded={open}
                title="打开 Token 统计"
                onClick={() => setOpen((current) => !current)}
            >
                <UsageRing percent={occupancy} size="small" severity={severity} />
                <span className="dsh-usage-summary-route">
                    <strong>{routeLabel}</strong>
                    <small>· {route.reasoningEffort || "默认"}</small>
                </span>
                <span className="dsh-usage-summary-context">
                    {occupied === undefined ? "--" : compactTokens(occupied)} / {capacity === undefined ? "--" : compactTokens(capacity)}
                </span>
            </button>
            {open ? (
                <div className="dsh-usage-panel" role="dialog" aria-label="Token 统计">
                    <div className="dsh-usage-panel-head">
                        <div>
                            <strong>Token 统计</strong>
                            <span>{routeLabel} · effort {route.reasoningEffort || "默认"}</span>
                        </div>
                        <button
                            type="button"
                            className="dsh-icon-button"
                            title="关闭"
                            onClick={() => setOpen(false)}
                        >
                            <CloseIcon />
                        </button>
                    </div>
                    <div
                        className="dsh-usage-context-stat"
                        title="估算值：基于最近 provider usage 与当前 Surface 变化推算下一次请求占用"
                    >
                        <UsageRing percent={occupancy} size="large" severity={severity} />
                        <div>
                            <span>上下文占用 · 估算</span>
                            <strong>
                                {occupied === undefined ? "--" : compactTokens(occupied)}
                                <small> / {capacity === undefined ? "--" : compactTokens(capacity)}</small>
                            </strong>
                        </div>
                    </div>
                    {billing ? (
                        <div className="dsh-token-chart" aria-label="会话计费 Token 分布">
                            <div className="dsh-token-chart-head">
                                <span>会话计费 Token</span>
                                <span>Provider usage</span>
                            </div>
                            <ChartRow
                                label="输入"
                                tokens={billing.uncachedInputTokens}
                                maximum={chartMaximum}
                                kind="input"
                                title="未缓存输入 token"
                            />
                            <ChartRow
                                label="输出"
                                tokens={billing.outputTokens}
                                maximum={chartMaximum}
                                kind="output"
                                title="输出 token"
                            />
                            <ChartRow
                                label="推理"
                                tokens={billing.reasoningTokens}
                                maximum={Math.max(1, billing.outputTokens)}
                                kind="reasoning"
                                suffix="输出子集"
                                title="Reasoning token，已包含在输出中"
                            />
                            <ChartRow
                                label="缓存读"
                                tokens={billing.cacheReadTokens}
                                maximum={chartMaximum}
                                kind="cache-read"
                                suffix={cacheHitRate === undefined ? undefined : `${formatter.format(cacheHitRate)}% 命中`}
                                title="缓存读取 token 与命中率"
                            />
                            <ChartRow
                                label="缓存写"
                                tokens={billing.cacheWriteTokens}
                                maximum={chartMaximum}
                                kind="cache-write"
                                title="缓存写入 token"
                            />
                        </div>
                    ) : (
                        <div className="dsh-usage-empty">暂无 provider 计费数据</div>
                    )}
                </div>
            ) : null}
        </section>
    );
}
