/** DeepSeek API billing period for a moment in time. */
export type DeepSeekPricingPeriod = "peak" | "offPeak";

// Weekend days bill at off-peak rates starting 2026-08-23 00:00 Beijing time
// (2026-08-22 16:00 UTC); before then weekends followed the weekday windows.
// https://api-docs.deepseek.com/quick_start/pricing
const WEEKEND_OFFPEAK_SINCE_MS = Date.UTC(2026, 7, 22, 16, 0, 0);

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * Classifies a moment as DeepSeek peak or off-peak billing. Off-peak rates are
 * half of peak rates. Peak hours are 01:00-04:00 and 06:00-10:00 UTC
 * (09:00-12:00 and 14:00-18:00 Beijing, GMT+8); every other hour bills at the
 * off-peak rate, and weekends bill at the off-peak rate all day.
 */
export function deepSeekPricingPeriod(now: Date): DeepSeekPricingPeriod {
    const beijing = new Date(now.getTime() + BEIJING_OFFSET_MS);
    const weekend = beijing.getUTCDay() === 0 || beijing.getUTCDay() === 6;
    if (weekend && now.getTime() >= WEEKEND_OFFPEAK_SINCE_MS) {
        return "offPeak";
    }
    const minuteOfDay = beijing.getUTCHours() * 60 + beijing.getUTCMinutes();
    const within = (fromMinute: number, toMinute: number): boolean =>
        fromMinute <= minuteOfDay && minuteOfDay < toMinute;
    return within(9 * 60, 12 * 60) || within(14 * 60, 18 * 60) ? "peak" : "offPeak";
}
