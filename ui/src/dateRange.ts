export type DateRangePreset = "24h" | "7d" | "30d" | "all";

/**
 * Returns the ISO string for the start of the given rolling window.
 * All windows are rolling (relative to now), not calendar-aligned.
 * "24h" = last 24 hours, "7d" = last 7 days, etc.
 */
export function presetToFromIso(preset: DateRangePreset): string | undefined {
  if (preset === "all") return undefined;
  const msMap: Record<Exclude<DateRangePreset, "all">, number> = {
    "24h":  24 * 60 * 60 * 1000,
    "7d":    7 * 24 * 60 * 60 * 1000,
    "30d":  30 * 24 * 60 * 60 * 1000,
  };
  return new Date(Date.now() - msMap[preset]).toISOString();
}

export const DATE_RANGE_OPTIONS: { value: DateRangePreset; label: string }[] = [
  { value: "24h",  label: "Last 24h" },
  { value: "7d",   label: "Last 7 days" },
  { value: "30d",  label: "Last 30 days" },
  { value: "all",  label: "All time" },
];
