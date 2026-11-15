import { describe, expect, it } from "vitest";
import { autoLoaded, lockedProviders, readProject, scanBlocks, varFiles } from "./tfproject";

const MAIN = `
# A comment with a { brace
resource "hcloud_server" "web" {
  count       = var.web_count
  name        = "web-\${count.index + 1}" // a } in a string
  labels      = { env = "prod", "team" = "ops" }
  firewall_ids = [
    hcloud_firewall.base.id,
  ]
  user_data = <<-EOT
    #cloud-config
    runcmd: [ "echo }" ]
  EOT
  lifecycle {
    ignore_changes = [user_data]
  }
}

/* resource "commented" "out" { } */
data "hcloud_image" "debian" {
  name = "debian-12"
}

module "network" {
  source = "./modules/network"
  cidr   = "10.0.0.0/16"
}

resource hcloud_server db {
  for_each = toset(["a"])
  ok = var.x == 1 ? "y" : "z"
}
`;

const VARS = `
variable "web_count" {
  type    = number
  default = 2
  description = "How many web servers"
}
variable "ssh_keys" {
  type      = list(string)
  sensitive = true
}
output "web_ips" { value = hcloud_server.web[*].ipv4_address }
output "token" {
  value     = var.x
  sensitive = true
}
terraform {
  backend "s3" {
    bucket = "acme"
  }
  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.48"
    }
    random = { source = "hashicorp/random" }
  }
}
`;

describe("a Terraform project read from its text", () => {
  it("finds every block, whatever braces strings, comments and heredocs hold", () => {
    const p = readProject([MAIN, VARS]);
    expect(p.resources).toEqual([
      { type: "hcloud_server", name: "web", counted: true },
      { type: "hcloud_server", name: "db", counted: true },
    ]);
    expect(p.data).toEqual([{ type: "hcloud_image", name: "debian" }]);
    expect(p.modules).toEqual([{ name: "network", source: "./modules/network" }]);
    expect(p.variables).toEqual([
      { name: "web_count", default: "2", type: "number", description: "How many web servers", sensitive: false },
      { name: "ssh_keys", default: null, type: "list(string)", description: null, sensitive: true },
    ]);
    expect(p.outputs).toEqual([
      { name: "web_ips", sensitive: false },
      { name: "token", sensitive: true },
    ]);
    expect(p.backend).toBe("s3");
    expect(p.providers).toEqual({ random: "hashicorp/random", hcloud: "hetznercloud/hcloud" });
  });

  it("keeps a block's own attributes, nested blocks apart", () => {
    const [web] = scanBlocks(MAIN);
    expect(web.attrs.count).toBe("var.web_count");
    expect(web.attrs.labels).toBe('{ env = "prod", "team" = "ops" }');
    expect(web.attrs.firewall_ids).toBe("[ hcloud_firewall.base.id, ]");
    expect(web.children.map((c) => c.kind)).toEqual(["lifecycle"]);
    expect(readProject(["terraform {\n  cloud {\n  }\n}\n"]).backend).toBe("cloud");
    expect(readProject(["resource \"x\" {\n}\n"]).resources).toEqual([]);
  });

  it("reads the versions the lock file pins", () => {
    const lock = `
provider "registry.terraform.io/hetznercloud/hcloud" {
  version     = "1.48.1"
  constraints = "~> 1.48"
  hashes = [
    "h1:abc=",
  ]
}
provider "example.com/x/y" {
  version = "0.1.0"
}
`;
    expect(lockedProviders(lock)).toEqual({ "hetznercloud/hcloud": "1.48.1", "example.com/x/y": "0.1.0" });
  });

  it("lists the values files, the ones Terraform loads by itself first", () => {
    expect(varFiles(["prod.tfvars", "main.tf", "b.auto.tfvars", "terraform.tfvars", "a.tfvars.json"])).toEqual([
      "b.auto.tfvars",
      "terraform.tfvars",
      "a.tfvars.json",
      "prod.tfvars",
    ]);
    expect(["terraform.tfvars", "x.auto.tfvars.json"].every(autoLoaded)).toBe(true);
    expect(autoLoaded("prod.tfvars")).toBe(false);
  });
});
