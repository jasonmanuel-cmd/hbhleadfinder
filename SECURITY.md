# Security Policy

## Reporting a Vulnerability

We take the security of this project seriously. If you believe you have found a
security vulnerability, please report it to us by emailing
**blunts954@gmail.com** with the subject line `SECURITY: <repo name>`.

Please include:
- A description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We will respond within 48 hours. Please do not publicly disclose the vulnerability
until we have had a chance to review and address it.

## Security Practices

- Dependencies are monitored via GitHub Dependabot
- Code is scanned via GitHub CodeQL
- Secrets are scanned via `npm audit` / `safety check` in CI
- Environment variables are never committed (`.env` is in `.gitignore`)
- Production secrets are stored in Vercel Environment Variables or Supabase Vault
