export type DateRangePreset = "today" | "7d" | "30d" | "all";

export function presetToFromIso(preset: DateRangePreset): string | undefined {
  if (preset === "all") return undefined;
  const now = new Date();
  if (preset === "today") {
    now.setHours(0, 0, 0, 0);
  } else if (preset === "7d") {
    now.setDate(now.getDate() - 7);
  } else if (preset === "30d") {
    now.setDate(now.getDate() - 30);
  }
  return now.toISOString();
}

export const DATE_RANGE_OPTIONS: { value: DateRangePreset; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "7d",    label: "Last 7 days" },
  { value: "30d",   label: "Last 30 days" },
  { value: "all",   label: "All time" },
];
