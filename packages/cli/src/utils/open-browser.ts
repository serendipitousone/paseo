import { spawn } from "node:child_process";

/**
 * Best-effort cross-platform browser opener for CLI OAuth flows. Returns true if the
 * opener process was spawned, false otherwise. Callers must always print the URL too,
 * so a failed/headless open still lets the user copy it.
 */
function browserOpenCommand(url: string): { command: string; args: string[] } {
  switch (process.platform) {
    case "darwin":
      return { command: "open", args: [url] };
    case "win32":
      return { command: "cmd", args: ["/c", "start", "", url] };
    default:
      return { command: "xdg-open", args: [url] };
  }
}

export function openBrowserUrl(url: string): boolean {
  const { command, args } = browserOpenCommand(url);

  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
