const { execFileSync } = require("node:child_process");
const MINIMUM = "0.7.5";
function version(value, source) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match) throw new Error(`${source} version is not stable Semantic Versioning: ${value || "missing"}`);
  const parts = match.slice(1, 4).map(Number);
  if (parts[0] === 0 && (parts[1] < 7 || parts[1] === 7 && parts[2] < 5)) throw new Error(`${source} version ${value} is below ${MINIMUM}`);
  return value;
}
function runHerdrCompatibilityPreflight(ops = { run: (command, args) => execFileSync(command, args, { encoding: "utf8", timeout: 10000 }) }) {
  let clientText = "";
  let serverText = "";
  try {
    clientText = ops.run("herdr", ["--version"]);
    serverText = ops.run("herdr", ["status", "server"]);
    const client = /^herdr (\S+)$/.exec(clientText.trim());
    if (!client) throw new Error("Herdr client probe must be exactly 'herdr <semver>'");
    version(client[1], "Herdr client");
    if (/\bprotocol_mismatch\b/.test(serverText)) throw new Error("Herdr server reports protocol_mismatch");
    const versions = [...serverText.matchAll(/^version: (.+)$/gm)];
    const compatibles = [...serverText.matchAll(/^compatible: (.+)$/gm)];
    if (versions.length !== 1) throw new Error("Herdr server probe has no unique version");
    if (compatibles.length !== 1 || compatibles[0][1] !== "yes") throw new Error("Herdr server is not compatible");
    version(versions[0][1], "Herdr server");
    return { clientVersion: client[1], serverVersion: versions[0][1] };
  } catch (error) {
    const client = /^herdr (\S+)$/.exec(clientText.trim())?.[1];
    const server = /^version: (\S+)$/m.exec(serverText)?.[1];
    const detected = client && server ? `Detected Herdr client ${client} and server ${server}` : `Herdr compatibility probe failed: ${error.message || String(error)}`;
    throw new Error(`${detected}; minimum required version is ${MINIMUM}. Quiet active deadloop automations, then run \`herdr update --handoff\`.`);
  }
}
module.exports = { runHerdrCompatibilityPreflight };
