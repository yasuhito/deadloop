const fs = require("node:fs");
const path = require("node:path");

function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(target);
    else if (entry.name.endsWith(".json")) JSON.parse(fs.readFileSync(target, "utf8"));
  }
}

visit(process.cwd());
