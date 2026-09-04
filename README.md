# Argus — AI-Augmented Web Surveillance & Change Intelligence

Argus provides autonomous web monitoring that tracks target URLs, parses structural and semantic DOM changes, and synthesizes visual alterations using Google's Gemini models.

## Technology Stack

- **Client Layer**: React 19, Vite, Tailwind CSS
- **API / Edge Layer**: Serverless micro-functions (`api/` runtime)
- **Persistence Layer**: Supabase (PostgreSQL)
- **Diff & Intelligence Engine**: `diff-match-patch`, Google Gemini API

## Local Development

```bash
# Install project dependencies
npm install

# Configure environment secrets
cp .env.example .env

# Start development runtime
npm run dev
```

## Change Intelligence Severity Levels

- `CRITICAL`: High-impact shifts in pricing, legal disclaimers, or authentication flows.
- `HIGH`: Significant copy or structural additions to core product features.
- `MEDIUM`: Standard marketing updates, navigation re-ordering, or UI restyles.
- `LOW`: Minor typographical changes, date stamps, or asset path refactors.
