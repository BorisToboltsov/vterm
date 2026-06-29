// Config snippets/templates inserted into the editor (Phase 12.6, made user-editable
// in 12.8+). The built-in defaults seed `settings.snippets`, which the user can edit /
// extend in Settings; the editor offers the ones matching the current language. Pure
// data + helpers; the editor inserts a snippet's body at the cursor.

import type { EditorLangKind } from "./editorlang";

export interface Snippet {
  id: string;
  name: string;
  /** Language this snippet targets; `null` = offer it for any file. */
  lang: EditorLangKind | null;
  body: string;
}

/** Language choices for the snippet editor's dropdown (`null` = any). */
export const SNIPPET_LANGS: { lang: EditorLangKind | null; label: string }[] = [
  { lang: null, label: "Any" },
  { lang: "yaml", label: "YAML" },
  { lang: "json", label: "JSON" },
  { lang: "toml", label: "TOML" },
  { lang: "ini", label: "Config / INI" },
  { lang: "nginx", label: "nginx" },
  { lang: "dockerfile", label: "Dockerfile" },
  { lang: "shell", label: "Shell" },
  { lang: "markdown", label: "Markdown" },
  { lang: "python", label: "Python" },
  { lang: "javascript", label: "JavaScript" },
  { lang: "typescript", label: "TypeScript" },
  { lang: "sql", label: "SQL" },
  { lang: "html", label: "HTML" },
  { lang: "css", label: "CSS" },
  { lang: "go", label: "Go" },
  { lang: "rust", label: "Rust" },
];

/** Built-in starter templates (a fresh copy each call). Stable ids per template. */
export function defaultSnippets(): Snippet[] {
  return [
    {
      id: "nginx-proxy",
      name: "nginx: reverse proxy",
      lang: "nginx",
      body: `server {
    listen 80;
    server_name example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
`,
    },
    {
      id: "nginx-static",
      name: "nginx: static site",
      lang: "nginx",
      body: `server {
    listen 80;
    server_name example.com;
    root /var/www/html;
    index index.html;

    location / {
        try_files $uri $uri/ =404;
    }
}
`,
    },
    {
      id: "nginx-ssl",
      name: "nginx: HTTPS + redirect",
      lang: "nginx",
      body: `server {
    listen 80;
    server_name example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name example.com;

    ssl_certificate     /etc/letsencrypt/live/example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
    }
}
`,
    },
    {
      id: "dockerfile-debian",
      name: "Dockerfile: Debian",
      lang: "dockerfile",
      body: `FROM debian:stable-slim
WORKDIR /app
COPY . .
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \\
    && rm -rf /var/lib/apt/lists/*
CMD ["./app"]
`,
    },
    {
      id: "dockerfile-node",
      name: "Dockerfile: Node.js",
      lang: "dockerfile",
      body: `FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
`,
    },
    {
      id: "dockerfile-python",
      name: "Dockerfile: Python",
      lang: "dockerfile",
      body: `FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
CMD ["python", "main.py"]
`,
    },
    {
      id: "dockerfile-multistage",
      name: "Dockerfile: multi-stage (Go)",
      lang: "dockerfile",
      body: `FROM golang:1.22 AS build
WORKDIR /src
COPY . .
RUN CGO_ENABLED=0 go build -o /app ./...

FROM gcr.io/distroless/static
COPY --from=build /app /app
ENTRYPOINT ["/app"]
`,
    },
    {
      id: "compose-service",
      name: "docker-compose: service",
      lang: "yaml",
      body: `services:
  app:
    image: nginx:latest
    restart: unless-stopped
    ports:
      - "8080:80"
    volumes:
      - ./data:/data
    environment:
      - TZ=UTC
`,
    },
    {
      id: "compose-postgres",
      name: "docker-compose: app + Postgres",
      lang: "yaml",
      body: `services:
  app:
    build: .
    restart: unless-stopped
    depends_on:
      - db
    environment:
      - DATABASE_URL=postgres://app:secret@db:5432/app
  db:
    image: postgres:16
    restart: unless-stopped
    environment:
      - POSTGRES_USER=app
      - POSTGRES_PASSWORD=secret
      - POSTGRES_DB=app
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
`,
    },
    {
      id: "k8s-deployment",
      name: "Kubernetes: Deployment",
      lang: "yaml",
      body: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
spec:
  replicas: 2
  selector:
    matchLabels:
      app: app
  template:
    metadata:
      labels:
        app: app
    spec:
      containers:
        - name: app
          image: nginx:latest
          ports:
            - containerPort: 80
`,
    },
    {
      id: "k8s-service",
      name: "Kubernetes: Service",
      lang: "yaml",
      body: `apiVersion: v1
kind: Service
metadata:
  name: app
spec:
  selector:
    app: app
  ports:
    - port: 80
      targetPort: 80
  type: ClusterIP
`,
    },
    {
      id: "gh-actions",
      name: "GitHub Actions: CI",
      lang: "yaml",
      body: `name: CI
on:
  push:
    branches: [main]
  pull_request:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: make test
`,
    },
    {
      id: "systemd-service",
      name: "systemd: service unit",
      lang: "ini",
      body: `[Unit]
Description=My Service
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/myapp
Restart=on-failure
User=myapp

[Install]
WantedBy=multi-user.target
`,
    },
    {
      id: "systemd-timer",
      name: "systemd: timer",
      lang: "ini",
      body: `[Unit]
Description=Run my job daily

[Timer]
OnCalendar=daily
Persistent=true

[Install]
WantedBy=timers.target
`,
    },
    {
      id: "bash-header",
      name: "Bash: strict script header",
      lang: "shell",
      body: `#!/usr/bin/env bash
set -euo pipefail
IFS=$'\\n\\t'

`,
    },
  ];
}

/**
 * Snippets relevant to a language: those targeting it, plus any universal ones.
 * Pure over an explicit list so the editor can pass `settings.snippets`.
 */
export function snippetsForLang(kind: EditorLangKind, list: Snippet[]): Snippet[] {
  return list.filter((s) => s.lang === kind || s.lang === null);
}

/** A blank snippet (for "add" in the settings editor). */
export function newSnippet(): Snippet {
  return { id: crypto.randomUUID(), name: "", lang: null, body: "" };
}

/** Validate an imported/stored snippets array, dropping malformed entries. */
export function sanitizeSnippets(raw: unknown): Snippet[] {
  if (!Array.isArray(raw)) return defaultSnippets();
  const langs = new Set(SNIPPET_LANGS.map((l) => l.lang));
  const out: Snippet[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.body !== "string") continue;
    const lang = (langs.has(r.lang as EditorLangKind) ? r.lang : null) as EditorLangKind | null;
    out.push({
      id: typeof r.id === "string" ? r.id : crypto.randomUUID(),
      name: typeof r.name === "string" ? r.name : "",
      lang,
      body: r.body,
    });
  }
  return out;
}
