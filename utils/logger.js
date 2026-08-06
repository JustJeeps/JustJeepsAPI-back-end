const { Axiom } = require("@axiomhq/js");

// Initialize Axiom client
const axiom = process.env.AXIOM_TOKEN
  ? new Axiom({
      token: process.env.AXIOM_TOKEN,
    })
  : null;

const dataset = process.env.AXIOM_DATASET || "justjeeps-api";

// Fields that can NEVER leave here in plain text (the destination is a
// third-party log).
const SENSITIVE_KEY = /pass|secret|token|authorization|apikey|api_key|credential|cookie/i;

// Keeps the shape of the payload (useful for debugging) while replacing the
// value with [REDACTED].
function redactSensitive(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 3) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactSensitive(item, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactSensitive(item, depth + 1);
    }
    return out;
  }
  if (typeof value === "string" && value.length > 500) return `${value.slice(0, 500)}…[truncated]`;
  return value;
}

// Log levels
const LOG_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

/**
 * Send log to Axiom
 */
const sendToAxiom = async (level, message, meta = {}) => {
  if (!axiom) {
    // Fallback to console if Axiom is not configured
    return;
  }

  try {
    await axiom.ingest(dataset, [
      {
        _time: new Date().toISOString(),
        level,
        message,
        environment: process.env.NODE_ENV || "development",
        service: "justjeeps-api",
        ...meta,
      },
    ]);
  } catch (err) {
    console.error("Failed to send log to Axiom:", err.message);
  }
};

/**
 * Logger object with methods for each level
 */
const logger = {
  error: (message, meta = {}) => {
    console.error(`[ERROR] ${message}`, meta);
    sendToAxiom("error", message, meta);
  },

  warn: (message, meta = {}) => {
    console.warn(`[WARN] ${message}`, meta);
    sendToAxiom("warn", message, meta);
  },

  info: (message, meta = {}) => {
    console.log(`[INFO] ${message}`, meta);
    sendToAxiom("info", message, meta);
  },

  debug: (message, meta = {}) => {
    if (process.env.NODE_ENV !== "production") {
      console.log(`[DEBUG] ${message}`, meta);
    }
    sendToAxiom("debug", message, meta);
  },

  // Beat for the "API Offline (P1)" monitor: a minimal event sent straight to
  // Axiom, with no console output (one per minute would pollute the docker
  // logs). It guarantees a continuous flow of events in the dataset even
  // overnight with no traffic, so "zero events in X minutes" goes back to
  // meaning a real outage (dead process or dead log pipeline).
  heartbeat: () => {
    sendToAxiom("info", "heartbeat", { type: "heartbeat" });
  },

  // Log HTTP request
  request: (req, res, duration) => {
    const meta = {
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      // duration (the string "123ms") is legacy: the p95 monitor in Axiom still
      // parses it. Remove it once that monitor moves to duration_ms.
      duration: `${duration}ms`,
      duration_ms: duration,
      userAgent: req.get("user-agent"),
      ip: req.ip || req.connection.remoteAddress,
      query: Object.keys(req.query).length > 0 ? req.query : undefined,
    };

    const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
    const message = `${req.method} ${req.path} ${res.statusCode} - ${duration}ms`;

    if (level === "error") {
      console.error(`[REQUEST] ${message}`);
    } else {
      console.log(`[REQUEST] ${message}`);
    }

    sendToAxiom(level, message, { type: "http_request", ...meta });
  },

  // Log API errors with full context
  apiError: (error, req = null) => {
    const meta = {
      type: "api_error",
      errorName: error.name,
      errorMessage: error.message,
      stack: error.stack,
    };

    if (req) {
      meta.method = req.method;
      meta.path = req.path;
      meta.query = redactSensitive(req.query);
      // The whole body used to go to Axiom: an error on /api/auth/login sent
      // the password in plain text to a third-party log. Now only the field
      // list goes out (to debug the shape) with the sensitive ones masked.
      meta.body = redactSensitive(req.body);
      meta.userId = req.user?.id;
    }

    console.error(`[API_ERROR] ${error.message}`, meta);
    sendToAxiom("error", error.message, meta);
  },

  // Flush logs (call before process exit)
  flush: async () => {
    if (axiom) {
      await axiom.flush();
    }
  },

  // DURABLE pipeline event: awaits ingest plus flush before returning, so that
  // short lived scripts and child processes do not lose the event on exit (the
  // info/warn/error methods are fire-and-forget and rely on a flush at
  // shutdown).
  //
  // ingest_run contract (emitted once per feed per ingestion run):
  //   { type: "ingest_run", feed, runId, trigger: "cron"|"manual"|"backfill",
  //     outcome: "success"|"partial"|"failed"|"skipped-unchanged",
  //     rowsIn, rowsChanged, rowsSkipped, rowsFailed, durationMs,
  //     watermarkFrom, watermarkTo, heapUsedMb, error }
  ingestEvent: async (event = {}) => {
    const payload = {
      _time: new Date().toISOString(),
      level: event.outcome === "failed" ? "error" : "info",
      message: event.type
        ? `${event.type}:${event.feed || event.name || ""} ${event.outcome || ""}`.trim()
        : "pipeline_event",
      environment: process.env.NODE_ENV || "development",
      service: "justjeeps-api",
      heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      ...event,
    };

    console.log(`[EVENT] ${payload.message}`, event);

    if (!axiom) return { success: false, reason: "axiom-not-configured" };

    try {
      await axiom.ingest(dataset, [payload]);
      await axiom.flush();
      return { success: true };
    } catch (err) {
      console.error("Failed to ingest pipeline event:", err.message);
      return { success: false, reason: err.message };
    }
  },
};

module.exports = logger;
