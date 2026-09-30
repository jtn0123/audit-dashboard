'use strict';

const fs = require('fs');
const path = require('path');

const MAX_BACKOFF_MS = 24 * 3_600_000;

/**
 * Remembers, across process deaths, whether a scan was running when the
 * process last went away.
 *
 * Under `restart: unless-stopped` a process that dies mid-scan is restarted
 * straight into another scan. When the scan is what kills it (memory, a
 * poisoned response), that is an unbounded loop spending API quota on every
 * lap: the 2026-09 outage restarted 24,802 times and drained the account's
 * whole GitHub rate limit, which broke every other tool sharing the token.
 *
 * A marker is written when a scan starts and cleared when it ends, however it
 * ends. Finding the marker at boot means the last process died mid-scan; each
 * consecutive such death doubles how long the next automatic scan waits.
 * A scan that completes, or a clean shutdown, resets the count.
 */
class ScanGuard {
  constructor(file) {
    this.file = file;
    this.crashes = 0;
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      const crashes = Number.isInteger(saved.crashes) && saved.crashes > 0 ? saved.crashes : 0;
      this.crashes = saved.inProgress ? crashes + 1 : crashes;
      if (saved.inProgress) this._write({ crashes: this.crashes, inProgress: false });
    } catch { /* no marker: the last run ended cleanly, or this is the first */ }
  }

  _write(state) {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(state));
    } catch { /* unwritable cache dir: the guard is best-effort */ }
  }

  begin() {
    this._write({ crashes: this.crashes, inProgress: true, startedAt: new Date().toISOString() });
  }

  /** The scan returned or threw, but the process survived it. */
  end() {
    this.crashes = 0;
    try { fs.rmSync(this.file, { force: true }); } catch { /* best-effort */ }
  }

  /** How long the next automatic scan should wait: 0, then base, 2x, 4x... */
  backoffMs(baseMs) {
    if (!this.crashes) return 0;
    return Math.min(baseMs * 2 ** (this.crashes - 1), MAX_BACKOFF_MS);
  }
}

module.exports = { ScanGuard, MAX_BACKOFF_MS };
