import pino from "pino";

// Create a centralized logger instance
// In a production environment, you might want to configure the level via an env var
const logger = pino({
  level: "info",
  formatters: {
    level: (label) => {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export default logger;
