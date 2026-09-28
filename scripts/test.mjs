/**
 * `npm test` runs this, and it runs vitest.
 *
 * WHY NOT CALL VITEST DIRECTLY: on Windows, a terminal can start in "c:\..."
 * (lowercase drive letter; VS Code terminals sometimes do). Vitest then loads two
 * copies of itself, one for each spelling of the path, and every test file fails
 * with "Vitest failed to find the runner". So this switches to the upper-case
 * spelling first, then starts vitest as a separate process from there.
 *
 * Any extra arguments are passed on: `npm test -- tests/razorpay.test.ts`.
 */

import { spawn } from "node:child_process";
import { join } from "node:path";

const cwd = process.cwd();
if (/^[a-z]:/.test(cwd)) process.chdir(cwd[0].toUpperCase() + cwd.slice(1));

// Built from the corrected folder, so vitest's own files get the same spelling.
// (npm always runs scripts from the project folder, where node_modules is.)
const vitest = join(process.cwd(), "node_modules", "vitest", "vitest.mjs");
const child = spawn(process.execPath, [vitest, "run", ...process.argv.slice(2)], { stdio: "inherit" });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
