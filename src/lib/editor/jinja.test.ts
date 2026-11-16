import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { hasTemplates, jinjaLayer, jinjaSpans } from "./jinja";
import { inlineVaultLines, vaultArgv, vaultHeader } from "./vault";

describe("jinjaSpans", () => {
  it("finds expressions, tags and comments", () => {
    const text = 'name: "{{ item.name }}"\n{% if x %}y{% endif %}\n{# note #}';
    expect(jinjaSpans(text).map((s) => [text.slice(s.from, s.to), s.kind])).toEqual([
      ["{{ item.name }}", "expr"],
      ["{% if x %}", "tag"],
      ["{% endif %}", "tag"],
      ["{# note #}", "comment"],
    ]);
  });

  it("offsets by the base and skips a stray brace", () => {
    expect(jinjaSpans("a { b {{ c }}", 10)).toEqual([{ from: 16, to: 23, kind: "expr" }]);
    expect(jinjaSpans("{{ never closed")).toEqual([]);
    expect(jinjaSpans("{")).toEqual([]);
  });

  it("knows which files carry templates", () => {
    expect(hasTemplates({ kind: "nginx", label: "nginx", jinja: true }, "x.conf.j2")).toBe(true);
    expect(hasTemplates({ kind: "ansible", label: "Ansible" }, "site.yml")).toBe(true);
    expect(hasTemplates({ kind: "yaml", label: "YAML" }, "/srv/charts/api/templates/svc.yaml")).toBe(true);
    expect(hasTemplates({ kind: "yaml", label: "YAML" }, "/srv/app/config.yaml")).toBe(false);
  });

  it("marks the delimiters and the body in a view", () => {
    const parent = document.createElement("div");
    const view = new EditorView({ parent, state: EditorState.create({ doc: "a: {{ b }}", extensions: [jinjaLayer()] }) });
    expect(parent.querySelectorAll(".cm-jinja-delim").length).toBe(2);
    expect(parent.querySelector(".cm-jinja")?.textContent).toBe(" b ");
    view.destroy();
  });
});

describe("vault", () => {
  it("reads the header of an encrypted file", () => {
    expect(vaultHeader("$ANSIBLE_VAULT;1.1;AES256\n6162\n")).toEqual({ version: "1.1", cipher: "AES256", label: null });
    expect(vaultHeader("$ANSIBLE_VAULT;1.2;AES256;prod\n")).toEqual({ version: "1.2", cipher: "AES256", label: "prod" });
    expect(vaultHeader("key: value\n")).toBeNull();
    expect(vaultHeader("")).toBeNull();
  });

  it("finds inline vault values", () => {
    expect(inlineVaultLines("a: 1\npw: !vault |\n  $ANSIBLE_VAULT;1.1;AES256\n")).toEqual([2]);
  });

  it("builds the user's own command, with the vault id when there is one", () => {
    expect(vaultArgv("/srv/vault.yml", false, null)).toEqual(["ansible-vault", "view", "/srv/vault.yml"]);
    expect(vaultArgv("/srv/v.yml", true, "prod")).toEqual(["ansible-vault", "edit", "--vault-id", "prod@prompt", "/srv/v.yml"]);
  });
});
