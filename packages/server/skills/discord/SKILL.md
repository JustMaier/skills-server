---
name: discord
description: Post messages and manage channels on Discord. Use when the user asks to send messages, list channels, or manage Discord.
---

# Discord Skill

This skill provides a CLI interface for posting messages and managing channels on Discord.

## Usage

Run commands via `discord.mjs`:

### List channels

```bash
node discord.mjs channels list
```

Returns a JSON array of available channels with their IDs and names.

### Send a message

```bash
node discord.mjs send <message> --channel=<id>
```

Sends a message to the specified channel. The `--channel` flag is required and must be a valid channel ID.

**Parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `<message>` | Yes | The text content to send |
| `--channel=<id>` | Yes | The target channel ID |

## Examples

```bash
# List all available channels
node discord.mjs channels list

# Send a greeting to the general channel
node discord.mjs send "Hello, team!" --channel=1001

# Send a message to the dev channel
node discord.mjs send "Build passed." --channel=1002
```
