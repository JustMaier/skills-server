#!/usr/bin/env node

const args = process.argv.slice(2);
const command = args[0];

if (command === 'echo') {
  console.log(args.slice(1).join(' '));
} else {
  console.log(`Hello! You said: ${args.join(' ')}`);
}
