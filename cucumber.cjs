const path = require("node:path");

const messagePath =
  process.env.DEADLOOP_CUCUMBER_MESSAGE_PATH ??
  path.join(require("node:os").tmpdir(), "deadloop-cucumber-messages.ndjson");

module.exports = {
  default: {
    paths: ["acceptance/features/**/*.feature.md"],
    requireModule: ["tsx/cjs"],
    require: ["acceptance/steps/**/*.ts", "acceptance/support/**/*.ts"],
    language: "ja",
    strict: true,
    format: ["progress", `message:${messagePath}`],
  },
};
