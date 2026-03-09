# RespireeClaw

A self-hosted AI personal assistant with cloud automation capabilities.

## Features

- 🤖 **AI Assistant** - Powered by Ollama (supports local and cloud models)
- ☁️ **Cloud Automation** - AWS EC2, RDS, Lambda, S3 management
- 👥 **Agent Teams** - Multi-agent collaboration with supervisor
- 💾 **Memory** - Vector-based semantic search + SQLite storage
- 📱 **Multi-channel** - Telegram, WhatsApp, Slack, Discord, and more
- 🎤 **Voice** - ElevenLabs voice synthesis
- 🌐 **Dashboards** - Web-based management UI

## Quick Start

```bash
# Clone the repository
git clone https://github.com/sriram162003/respireeclaw.git
cd respireeclaw

# Install dependencies
npm install

# Setup
node agent.js onboard

# Start
node agent.js --daemon
```

## Configuration

Configuration is stored in `~/.aura/`:
- `config.yaml` - Main settings
- `agents.yaml` - Agent definitions
- Memory and logs

## CLI Commands

```bash
node agent.js onboard    # First-time setup
node agent.js --daemon   # Start server
node agent.js status      # Check status
node agent.js stop        # Stop server
node agent.js logs        # View logs
```

## Tech Stack

- **Runtime**: Node.js 20+
- **LLM**: Ollama, OpenAI, Anthropic, Gemini
- **Storage**: SQLite + Vector embeddings
- **Channels**: Telegram, WhatsApp, Slack, Discord, Teams

## License

MIT
