/* Sequence-window delivery estimate: complete, unique telemetry frames only.
   Initial frames before subscription and losses after the last observed sequence
   cannot be counted. This is not a radio-level packet delivery measurement. */
(function (root) {
  'use strict';
  class DeliveryWindow {
    constructor() { this.reset(); }
    reset() {
      this.device = null; this.boot = null; this.first = null; this.highest = null;
      this.lastUptime = null; this.seen = new Set();
    }
    observe(payload) {
      if (payload.message_type !== 'telemetry' && !(payload.gps || payload.acceleration || payload.gyroscope)) return null;
      if (String(payload.message_type || '').startsWith('benchmark_')) return null;
      const seq = payload.sequence;
      if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) return null;
      const device = String(payload.device_id || 'unknown');
      const boot = payload.boot_id == null ? null : String(payload.boot_id);
      const uptime = typeof payload.uptime_ms === 'number' && Number.isFinite(payload.uptime_ms) ? payload.uptime_ms : null;
      const restarted = boot !== this.boot || device !== this.device ||
        (seq <= 1 && this.highest > seq && uptime !== null && this.lastUptime !== null && uptime < this.lastUptime);
      if (restarted) this.reset();
      this.device = device; this.boot = boot;
      if (this.first === null) this.first = this.highest = seq;
      // Frames older than the subscription window don't change its denominator.
      if (seq < this.first) return null;
      this.seen.add(seq); this.highest = Math.max(seq, this.highest);
      if (uptime !== null) this.lastUptime = Math.max(uptime, this.lastUptime ?? 0);
      const expected = this.highest - this.first + 1;
      return { received: this.seen.size, expected, missing: expected - this.seen.size };
    }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = DeliveryWindow;
  else root.VtaasDeliveryWindow = DeliveryWindow;
})(typeof window === 'undefined' ? this : window);
