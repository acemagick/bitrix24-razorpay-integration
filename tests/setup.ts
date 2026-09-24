/**
 * Runs before every test file.
 *
 * The service logs a lot on purpose (every webhook, every failure), which would
 * bury the test results. So console output is silenced during tests. A test that
 * wants to check a log line can still read it: `vi.mocked(console.error).mock.calls`.
 */

import { beforeEach, vi } from "vitest";

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
