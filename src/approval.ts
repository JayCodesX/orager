import fs from "node:fs";
import readline from "node:readline";

/**
 * Prompt the user for approval of a tool call, reading from /dev/tty so this
 * works even when stdin is piped.  Returns true if the user types "y" or "yes".
 */
export async function promptApproval(
  toolName: string,
  input: Record<string, unknown>
): Promise<boolean> {
  const formatted = JSON.stringify(input, null, 2);

  process.stderr.write("\n[orager] Tool approval required\n");
  process.stderr.write(`  Tool : ${toolName}\n`);
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

    rl.once("line", (line) => {
      answered = true;
      rl.close();
      ttyStream?.destroy();
      const answer = line.trim().toLowerCase();
      resolve(answer === "y" || answer === "yes");
    });

    rl.once("close", () => {
      if (!answered) {
        ttyStream?.destroy();
        resolve(false);
      }
    });
  });
}
