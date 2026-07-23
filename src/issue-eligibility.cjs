function issueLabelNames(issue) {
  return new Set(
    (Array.isArray(issue.labels) ? issue.labels : []).map((label) =>
      typeof label === "string"
        ? label
        : label && typeof label === "object" && !Array.isArray(label)
          ? String(label.name || "")
          : "",
    ),
  );
}

function passesIssueLabelGate(issue, gate) {
  const labels = issueLabelNames(issue);
  return gate.required.every((label) => labels.has(label)) && !gate.blocked.some((label) => labels.has(label));
}

module.exports = { issueLabelNames, passesIssueLabelGate };
