#!/usr/bin/env node

const args = process.argv.slice(2);
const command = args[0];

if (command === 'echo') {
  console.log(args.slice(1).join(' '));
} else if (command === 'env') {
  // Print a specific env var value (for testing env injection)
  const key = args[1];
  console.log(process.env[key] || '');
} else {
  console.log(`Hello! You said: ${args.join(' ')}`);
}
