class ServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function requireThat(condition, code, message) {
  if (!condition) throw new ServiceError(code, message);
}

function documentId(value, name) {
  requireThat(typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value),
      "invalid-argument", `${name} must be a document ID.`);
  return value;
}

function integer(value, min, max, name) {
  requireThat(Number.isInteger(value) && value >= min && value <= max,
      "invalid-argument", `${name} must be an integer from ${min} to ${max}.`);
  return value;
}

module.exports = {ServiceError, requireThat, documentId, integer};
