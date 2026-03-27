import fs from "node:fs";
import readline from "node:readline";

/**
 * Prompt the user for approval of a tool call, reading from /dev/tty so this
 * works even when stdin is piped.  Returns true if the user types "y" or "yes".
 * Auto-denies after timeoutMs (default 5 minutes).
 */
export async function promptApproval(
  toolName: string,
  input: Record<string, unknown>,
  timeoutMs = 5 * 60 * 1000,
): Promise<boolean> {
  // In daemon mode there is no controlling terminal — approval via /dev/tty is impossible.
  // Return false immediately with a clear diagnostic rather than silently denying.
  if (process.env.ORAGER_DAEMON_MODE === "1" || !process.stdin.isTTY) {
    process.stderr.write(
      `\n[orager] Tool approval required for '${toolName.replace(/[\x00-\x1f\x7f]/g, "?")}' but no TTY is available (running in daemon/headless mode). ` +
      `Denying automatically. To allow this tool without approval, add it to your requireApproval exclusion list, ` +
      `or run interactively.\n`,
    );
    return false;
  }

  // Sanitize tool name to prevent terminal prompt injection via control characters
  // (newlines, ANSI escapes). A malicious MCP tool could craft a name that
  // renders as additional instructions in the approval prompt.
  const safeToolName = toolName.replace(/[\x00-\x1f\x7f]/g, (c) => `<0x${c.charCodeAt(0).toString(16).padStart(2, "0")}>`);
  // Sanitize input JSON to prevent ANSI escape injection from malicious tool inputs
  const formatted = JSON.stringify(input, null, 2)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, (c) => `<0x${c.charCodeAt(0).toString(16).padStart(2, "0")}>`);

  process.stderr.write("\n[orager] Tool approval required\n");
  process.stderr.write(`  Tool : ${safeToolName}\n`);
  process.stderr.write(`  Input: ${formatted}\n`);
  process.stderr.write("Allow? [y/N] ");

  let ttyStream: fs.ReadStream | null = null;
  try {
    ttyStream = fs.createReadStream("/dev/tty");
  } catch {
    // /dev/tty unavailable (e.g. CI environment) — deny by default
    process.stderr.write("\n[orager] /dev/tty not available, denying\n");
    return false;
  }

  const rl = readline.createInterface({ input: ttyStream });

  return new Promise<boolean>((resolve) => {
    let answered = false;

    const timer = setTimeout(() => {
      if (!answered) {
        answered = true;
        countdownTimers.forEach(clearTimeout);
        rl.close();
        ttyStream?.destroy();
        process.stderr.write(
          `\n[orager] approval timed out after ${Math.round(timeoutMs / 1000)}s — denying\n`,
        );
        resolve(false);
      }
    }, timeoutMs);

    // Emit countdown warnings at 1-minute intervals before auto-deny
    const countdownTimers: ReturnType<typeof setTimeout>[] = [];
    const totalMinutes = Math.floor(timeoutMs / 60_000);
    for (let minutesLeft = 1; minutesLeft < totalMinutes; minutesLeft++) {
      const warnAt = timeoutMs - minutesLeft * 60_000;
      if (warnAt > 0) {
        countdownTimers.push(
          setTimeout(() => {
            if (!answered) {
              process.stderr.write(
                `[orager] approval pending — auto-deny in ${minutesLeft} minute${minutesLeft !== 1 ? "s" : ""}\n`,
              );
            }
          }, warnAt),
        );
      }
    }

    rl.once("line", (line) => {
      if (!answered) {
        answered = true;
        clearTimeout(timer);
        countdownTimers.forEach(clearTimeout);
        rl.close();
        ttyStream?.destroy();
        const answer = line.trim().toLowerCase();
        resolve(answer === "y" || answer === "yes");
      }
    });

    rl.once("close", () => {
      if (!answered) {
        answered = true;
        clearTimeout(timer);
        countdownTimers.forEach(clearTimeout);
        ttyStream?.destroy();
        resolve(false);
      }
    });
  });
}
