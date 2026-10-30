'use strict';

const crypto = require('crypto');

class AppError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = Number(options.status) || 500;
    this.operationId = options.operationId || operationId();
    this.details = options.details && typeof options.details === 'object' ? options.details : undefined;
    this.cause = options.cause;
  }
}

function operationId() {
  return crypto.randomBytes(8).toString('hex');
}

function redact(value) {
  let text = String(value === undefined || value === null ? '' : value);
  text = text.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]');
  text = text.replace(/(?:[A-Z]:[\\/]|\\\\)[^\r\n"<>|]*/gi, '[REDACTED_PATH]');
  text = text.replace(/https?:\/\/[^\s"<>]+/gi, '[REDACTED_URL]');
  text = text.replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]');
  text = text.replace(/(access[_-]?token|refresh[_-]?token|identity[_-]?token|api[_-]?key|client[_-]?api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');
  text = text.replace(/\b[A-Fa-f0-9]{32,}\b/g, '[REDACTED_HEX]');
  text = text.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[REDACTED_EMAIL]');
  return text.replace(/[\r\n]+/g, ' ').slice(0, 1200);
}

function errorInfo(err, fallbackCode = 'INTERNAL_ERROR') {
  const e = err instanceof AppError ? err : null;
  return {
    ok: false,
    error: redact(e ? e.message : err && err.message ? err.message : err),
    code: e ? e.code : fallbackCode,
    operationId: e ? e.operationId : operationId(),
  };
}

module.exports = { AppError, operationId, redact, errorInfo };
