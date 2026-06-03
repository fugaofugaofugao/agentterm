# Security Policy

AgentTerm Monitor controls interactive terminals. Treat access to an AgentTerm Monitor server as access to the underlying user account and shell.

## Recommendations

- Use strong passwords.
- Keep `config.yaml`, server keys, JWT secrets, and remote URLs private.
- Put AgentTerm Monitor behind HTTPS or a trusted tunnel/VPN before exposing it outside a LAN.
- Restrict access to trusted devices and users.
- Rotate secrets immediately if they are accidentally committed or shared.

## Reporting vulnerabilities

Please open a private security advisory on GitHub or contact the maintainer through GitHub. Do not publish exploitable details before a fix is available.
