// Built-in config snippets/templates inserted into the editor (Phase 12.6). Pure
// data + a tiny filter; the editor inserts a snippet's body at the cursor. Names
// are technical and not translated (like language labels).

import type { EditorLangKind } from "./editorlang";

export interface Snippet {
  id: string;
  name: string;
  /** Language this snippet targets; `null` = offer it for any file. */
  lang: EditorLangKind | null;
  body: string;
}

export const SNIPPETS: Snippet[] = [
  {
    id: "nginx-server",
    name: "nginx server block",
    lang: "ini",
    body: `server {
    listen 80;
    server_name example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
`,
  },
  {
    id: "systemd-service",
    name: "systemd service unit",
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
    id: "compose-service",
    name: "docker-compose service",
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
    id: "k8s-deployment",
    name: "Kubernetes Deployment",
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
    id: "dockerfile",
    name: "Dockerfile",
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
    id: "bash-header",
    name: "Bash script header",
    lang: "shell",
    body: `#!/usr/bin/env bash
set -euo pipefail
IFS=$'\\n\\t'

`,
  },
];

/**
 * Snippets relevant to a language: those targeting it, plus any universal ones.
 * Empty when nothing applies (the editor hides the menu then).
 */
export function snippetsForLang(kind: EditorLangKind): Snippet[] {
  return SNIPPETS.filter((s) => s.lang === kind || s.lang === null);
}
