import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseCliArgs } from "./dsh-watchdog.mjs";

const modulePath = fileURLToPath(import.meta.url);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function armIndependentWatchdog(
  argv,
  { timeoutMs = 15_000 } = {},
) {
  const parsed = parseCliArgs(argv);
  const finalPath = parsed.evidencePath;
  const armedPath = `${finalPath}.armed.json`;
  const processLog = `${finalPath}.process.log`;
  for (const candidate of [
    finalPath,
    armedPath,
    `${finalPath}.events.jsonl`,
    processLog,
  ])
    if (fs.existsSync(candidate))
      throw new Error(`evidence already exists: ${candidate}`);
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  const log = fs.openSync(processLog, "wx");
  const child = spawn(
    process.execPath,
    [path.join(path.dirname(modulePath), "dsh-watchdog.mjs"), ...argv],
    {
      cwd: path.dirname(modulePath),
      detached: true,
      windowsHide: true,
      stdio: ["ignore", log, log],
    },
  );
  fs.closeSync(log);
  child.unref();
  try {
    const limit = Date.now() + timeoutMs;
    while (Date.now() < limit) {
      if (fs.existsSync(armedPath)) {
        const armed = JSON.parse(fs.readFileSync(armedPath, "utf8"));
        if (armed.status !== "ARMED" || armed.watchdogPid !== child.pid)
          throw new Error(
            "watchdog armed evidence does not match launched process",
          );
        return { ...armed, processLog };
      }
      if (fs.existsSync(finalPath)) {
        const failure = JSON.parse(fs.readFileSync(finalPath, "utf8"));
        throw new Error(
          `watchdog failed before arming: ${failure.supervisorErrors?.join("; ") ?? failure.status}`,
        );
      }
      await sleep(100);
    }
    throw new Error(
      `watchdog did not write ARMED evidence within ${timeoutMs}ms`,
    );
  } catch (error) {
    if (!fs.existsSync(armedPath) && child.exitCode === null) child.kill();
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  try {
    const armed = await armIndependentWatchdog(process.argv.slice(2));
    console.log(
      JSON.stringify(
        {
          status: armed.status,
          watchdogPid: armed.watchdogPid,
          startedAt: armed.startedAt,
          deadlineAt: armed.deadlineAt,
          armedAt: armed.armedAt,
          evidence: armed.evidence,
          processLog: armed.processLog,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
