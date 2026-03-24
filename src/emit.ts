import type {
  EmitEvent,
} from "./types.js";

export function emit(event: EmitEvent): void {
  const line = JSON.stringify(event);
  process.stdout.write(line + "\n");
}
