# Argus — AI-Augmented Web Surveillance & Change Intelligence

Argus provides autonomous web monitoring that tracks target URLs, parses structural and semantic DOM changes, and synthesizes visual alterations using Google's Gemini models.

## Technology Stack

- **Client Layer**: React 19, Vite, Tailwind CSS
- **API / Edge Layer**: Serverless micro-functions (`api/` runtime)
- **Persistence Layer**: Supabase (PostgreSQL)
- **Diff & Intelligence Engine**: `diff-match-patch`, Google Gemini API
