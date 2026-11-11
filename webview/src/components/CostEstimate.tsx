import React from "react";
import type { SessionCostView } from "../../../src/sessionCost";
import { t } from "../i18n";
export function CostEstimate({ value }: { value: SessionCostView | undefined }): React.JSX.Element | null {
    if (!value) return null;
    return (
        <div className="dsh-cost-estimate" aria-label={t("Estimated session cost")}>
            {value.totals.map((total) => (
                <span
                    key={total.currency}
                    title={t("Input {input} · output {output} · cache {cache}", {
                        input: total.input.toFixed(6),
                        output: total.output.toFixed(6),
                        cache: total.cache.toFixed(6),
                    })}
                >
                    {t("Estimated cost")} {total.currency} {total.total.toFixed(6)}
                </span>
            ))}
            <span>{t("{count} priced requests", { count: value.pricedRequests })}</span>
            {value.unpricedRequests ? (
                <span>{t("{count} requests have no matching rate", { count: value.unpricedRequests })}</span>
            ) : null}
        </div>
    );
}
