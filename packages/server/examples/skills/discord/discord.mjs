#!/usr/bin/env node

const args = process.argv.slice(2);

function printError(message) {
  console.error(JSON.stringify({ error: message }));
  process.exit(1);
}

function handleChannelsList() {
  const channels = [
    { id: "1001", name: "general" },
    { id: "1002", name: "dev" },
    { id: "1003", name: "random" },
  ];
  console.log(JSON.stringify(channels, null, 2));
}

function handleSend(args) {
  let channel = null;
  const messageParts = [];

  for (const arg of args) {
    if (arg.startsWith("--channel=")) {
      channel = arg.slice("--channel=".length);
    } else {
      messageParts.push(arg);
    }
  }

  const message = messageParts.join(" ");

  if (!message) {
    printError("Missing required argument: <message>");
  }

  if (!channel) {
    printError("Missing required flag: --channel=<id>");
  }

  console.log(JSON.stringify({ success: true, channel, message }, null, 2));
}

// --- Main ---

if (args.length === 0) {
  printError("No command provided. Available commands: channels list, send <message> --channel=<id>");
}

const command = args[0];

if (command === "channels" && args[1] === "list") {
  handleChannelsList();
} else if (command === "send") {
  handleSend(args.slice(1));
} else {
  printError(`Unknown command: ${args.join(" ")}. Available commands: channels list, send <message> --channel=<id>`);
}
