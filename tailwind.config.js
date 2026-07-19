/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#0a0a0a",
        surface: "#111111",
        "surface-2": "#1a1a1a",
        border: "#1f1f1f",
        "border-strong": "#2a2a2a",
        "text-primary": "#e5e5e5",
        "text-secondary": "#888888",
        "text-muted": "#555555",
        "agent-idle": "#333333",
        "agent-running": "#1d4ed8",
        "agent-complete": "#15803d",
        "agent-error": "#b91c1c",
        "severity-low": "#15803d",
        "severity-medium": "#d97706",
        "severity-high": "#dc2626",
        "severity-critical": "#7c3aed",
      },
      fontFamily: {
        mono: ["'JetBrains Mono'", "'Fira Code'", "monospace"],
      },
    },
  },
  plugins: [],
}