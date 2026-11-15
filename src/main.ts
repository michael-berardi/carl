// Dispatch help before loading the gateway, SDKs or version's git lookup.
import { USAGE, commandHelp, helpRequested } from "./cli-help.ts";
const [cmd, ...args] = process.argv.slice(2);
if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
  console.log("Usage: carl <command>\n\nCommands:\n" + Object.entries(USAGE).map(([name, usage]) => `  carl ${name} ${usage}`).join("\n") + "\n\nUse carl <command> --help for command help.");
} else if (cmd && Object.hasOwn(USAGE, cmd) && helpRequested(cmd, args)) {
  console.log(commandHelp(cmd, args));
} else {
  await import("./cli-main.ts");
}
