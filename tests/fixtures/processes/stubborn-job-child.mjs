import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.env.MIRAWIND_JOB_STORAGE_ROOT;
if (!root) process.exit(91);
const eventsPath = join(root, "termination-events.txt");
const pidsPath = join(root, "termination-pids.json");
let jobId;

function event(name) {
  appendFileSync(eventsPath, `${name}\n`, { encoding: "utf8" });
  progress();
}

function progress() {
  process.send?.({
    jobId,
    phase: "permanent_book_deletion",
    progress: {
      completed: 0,
      processed_bytes: null,
      total: 1,
      unit: "steps",
    },
    protocolVersion: 7,
    type: "progress",
  });
}

process.on("SIGTERM", () => event("sigterm"));
process.on("message", (message) => {
  if (message?.type === "run") {
    jobId = message.input.jobId;
    const grandchild = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],
      { stdio: "ignore" },
    );
    writeFileSync(
      pidsPath,
      JSON.stringify({ child: process.pid, grandchild: grandchild.pid }),
      { encoding: "utf8" },
    );
    progress();
    return;
  }
  if (message?.type === "cancel" && message.jobId === jobId) {
    event("cancel");
  }
});

setInterval(() => {}, 1_000);
