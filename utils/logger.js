const { Axiom } = require("@axiomhq/js");

// Initialize Axiom client
const axiom = process.env.AXIOM_TOKEN
  ? new Axiom({
      token: process.env.AXIOM_TOKEN,
    })
  : null;

const dataset = process.env.AXIOM_DATASET || "justjeeps-api";

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

  // Log HTTP request
  request: (req, res, duration) => {
    const meta = {
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      duration: `${duration}ms`,
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
      meta.query = req.query;
      meta.body = req.body;
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
};

module.exports = logger;
