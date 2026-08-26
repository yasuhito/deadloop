/**
 * Local filesystem detail never belongs in text deadloop publishes to GitHub.
 *
 * Runtime-derived strings — launch failures, review notes, command output — embed host command
 * lines and absolute local paths. Every publication boundary scrubs path-shaped fragments before
 * the text leaves the host; the reason itself stays readable, only the location is omitted.
 */

const LOCAL_DETAIL_RE = /(?:\bfile:\/\/+|(?<!:)\/\/|\\\\)[^\s`'")]+|(?:^|[^A-Za-z0-9_/])(?:\/(?!\/)[^\s`'")]+|[A-Za-z]:\\)[^\s`'")]*/gi;

function redactLocalDetail(value: unknown): string {
  return String(value || "").replace(LOCAL_DETAIL_RE, (fragment) => `${fragment.startsWith(" ") ? " " : ""}[internal path omitted]`);
}

module.exports = { LOCAL_DETAIL_RE, redactLocalDetail };
