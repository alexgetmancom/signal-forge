/**
 * Preloaded before every test file (see `bunfig.toml`): the service's own log lines are kept off the
 * console, so what a test run prints is what the run itself has to say.
 *
 * A test that asserts on a logged line calls `logTo` with its own sink and restores `null` after.
 */
import { logTo } from "../src/logger.js";

logTo(null);
