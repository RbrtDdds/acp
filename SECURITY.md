# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability in ACP, please report it responsibly.

**Do NOT open a public issue.**

Instead, email **mr.r.dudas@gmail.com** with:

- A description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

You will receive a response within 48 hours. We will work with you to understand the issue and coordinate a fix before any public disclosure.

## Security Considerations

ACP stores project context locally in SQLite (`~/.acp/acp.db`). Some things to be aware of:

- **Config file permissions**: ACP sets `chmod 0600` on `~/.acp/config.json` to prevent other users from reading your configuration.
- **No secrets in facts**: ACP's fact extractor is designed to capture decisions, architecture, and conventions — not API keys, passwords, or tokens. If you notice sensitive data being extracted, please report it.
- **SQL injection**: All database queries use parameterized statements. If you find a query using string concatenation, please report it.
- **MCP server**: The MCP server runs locally via stdio transport and does not expose any network ports.
