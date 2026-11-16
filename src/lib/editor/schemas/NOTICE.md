# Vendored JSON schemas

The editor checks YAML against these schemas without the network (ADR 0078).
They are fetched at development time by `scripts/schemas.mjs`, which trims
descriptions and, for Kubernetes, keeps the definitions of the common kinds.
Each source is pinned to one commit and to the SHA-256 of the bytes it served
when it was reviewed; a download that does not match writes nothing.
Only sources under MIT or Apache-2.0 are vendored; the Ansible schemas of
ansible-lint are GPL-3.0 and are not here.

| File | Source | License |
|------|--------|---------|
| `compose.json` | compose-spec/compose-spec @ `3a4a6995`, `schema/compose-spec.json` | Apache-2.0 |
| `gh-workflow.json` | SchemaStore/schemastore @ `202f2efd`, `github-workflow.json` | Apache-2.0 |
| `gh-action.json` | SchemaStore/schemastore @ `202f2efd`, `github-action.json` | Apache-2.0 |
| `gitlab-ci.json` | gitlab-org/gitlab @ `1a00245c`, `app/assets/javascripts/editor/schema/ci.json` | MIT |
| `kustomization.json` | SchemaStore/schemastore @ `202f2efd`, `kustomization.json` | Apache-2.0 |
| `chart.json` | SchemaStore/schemastore @ `202f2efd`, `chart.json` | Apache-2.0 |
| `k8s.json` | kubernetes/kubernetes `v1.31.0` @ `9edcffcd`, `api/openapi-spec/swagger.json` (definitions of 26 kinds) | Apache-2.0 |

Copyright of each schema stays with its authors: the Compose Specification
authors, the SchemaStore contributors, GitLab Inc., The Kubernetes Authors.
