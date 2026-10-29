import { describe, expect, it } from "vitest";
import { classifyImage, dataUrl, imageMime } from "./mdimage";

describe("imageMime", () => {
  it("maps the extensions we inline, case-insensitively", () => {
    expect(imageMime("a.png")).toBe("image/png");
    expect(imageMime("a.JPG")).toBe("image/jpeg");
    expect(imageMime("a.jpeg")).toBe("image/jpeg");
    expect(imageMime("a.webp")).toBe("image/webp");
  });

  it("looks past a query or fragment", () => {
    expect(imageMime("logo.png?v=2")).toBe("image/png");
    expect(imageMime("logo.png#top")).toBe("image/png");
  });

  it("refuses SVG and everything unknown", () => {
    // SVG is a document, not a bitmap: its inertness inside <img> is an engine
    // behaviour we do not control, and no README here needs it.
    expect(imageMime("diagram.svg")).toBeNull();
    expect(imageMime("notes.md")).toBeNull();
    expect(imageMime("noextension")).toBeNull();
  });
});

describe("classifyImage", () => {
  const doc = "/srv/app/README.md";

  it("resolves a document-relative target against the document's directory", () => {
    expect(classifyImage(doc, "./docs/shot.png")).toEqual({
      kind: "file",
      path: "/srv/app/docs/shot.png",
      mime: "image/png",
    });
    expect(classifyImage(doc, "docs/shot.png")).toMatchObject({
      path: "/srv/app/docs/shot.png",
    });
    expect(classifyImage(doc, "../shared/shot.png")).toMatchObject({
      path: "/srv/shared/shot.png",
    });
  });

  it("keeps an absolute target as-is", () => {
    expect(classifyImage(doc, "/var/www/logo.png")).toMatchObject({
      path: "/var/www/logo.png",
    });
  });

  it("calls remote targets remote — they can never load here", () => {
    // Not "broken": the CSP has no remote origin and the offline invariant forbids
    // the WebView reaching the network, so the preview says so in its own words.
    expect(classifyImage(doc, "https://img.shields.io/badge/v-1-blue")).toEqual({ kind: "remote" });
    expect(classifyImage(doc, "http://x.test/a.png")).toEqual({ kind: "remote" });
    expect(classifyImage(doc, "//x.test/a.png")).toEqual({ kind: "remote" });
  });

  it("passes through an inline data: image of a type we accept", () => {
    const url = "data:image/png;base64,iVBORw0KGgo=";
    expect(classifyImage(doc, url)).toEqual({ kind: "data", url });
  });

  it("refuses a data: URL outside the image MIME set", () => {
    expect(classifyImage(doc, "data:text/html;base64,PHNjcmlwdD4=")).toEqual({ kind: "remote" });
    expect(classifyImage(doc, "data:image/svg+xml;base64,PHN2Zz4=")).toEqual({ kind: "remote" });
  });

  it("refuses a local target whose type we do not inline", () => {
    expect(classifyImage(doc, "./notes.md")).toEqual({ kind: "unsupported" });
    expect(classifyImage(doc, "./diagram.svg")).toEqual({ kind: "unsupported" });
  });

  it("refuses a target that climbs above the root", () => {
    expect(classifyImage("/a/README.md", "../../../x.png")).toEqual({ kind: "unsupported" });
  });

  it("resolves natively for a Windows document", () => {
    // A drive letter reads as a URL scheme to a naive test, which would have sent
    // every Windows image down the "remote" path.
    expect(classifyImage("C:\\proj\\README.md", "docs\\shot.png")).toEqual({
      kind: "file",
      path: "C:\\proj\\docs\\shot.png",
      mime: "image/png",
    });
    expect(classifyImage("C:\\proj\\README.md", "D:/img/a.png")).toMatchObject({
      path: "D:/img/a.png",
    });
  });
});

describe("dataUrl", () => {
  it("assembles what the renderer will accept as an <img src>", () => {
    expect(dataUrl("image/png", "iVBORw0KGgo=")).toBe("data:image/png;base64,iVBORw0KGgo=");
  });
});
