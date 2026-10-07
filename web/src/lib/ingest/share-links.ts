/**
 * Share-link rewrites: turn the link people copy from a browser into one that downloads the file.
 * Mirrors `rewrite_share_link` in src/autotinker/data/fetch.py (plus Dropbox). Isomorphic, no Node imports.
 */

export function rewriteShareLink(raw: string): string {
  const input = raw.trim();
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return input;
  }
  const host = u.hostname.toLowerCase();
  const segs = u.pathname.split("/").filter(Boolean);

  // GitHub: github.com/<owner>/<repo>/blob/<ref>/<path> -> raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>
  if ((host === "github.com" || host === "www.github.com") && segs.length >= 5 && (segs[2] === "blob" || segs[2] === "raw")) {
    const [owner, repo, , ref, ...rest] = segs;
    return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${rest.join("/")}`;
  }

  // Google Drive: /file/d/<id>/view, /open?id=<id>, /uc?id=<id> -> uc?export=download&id=<id>
  if (host === "drive.google.com") {
    let id: string | null = null;
    if (segs.length >= 3 && segs[0] === "file" && segs[1] === "d") id = segs[2];
    else if ((segs[0] === "open" || segs[0] === "uc") && u.searchParams.get("id")) id = u.searchParams.get("id");
    if (id) return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`;
  }

  // Google Sheets: /spreadsheets/d/<id>/edit#gid=<gid> -> /export?format=csv&gid=<gid>
  if (host === "docs.google.com" && segs.length >= 3 && segs[0] === "spreadsheets" && segs[1] === "d") {
    const out = `https://docs.google.com/spreadsheets/d/${segs[2]}/export?format=csv`;
    const gid = u.searchParams.get("gid") ?? new URLSearchParams(u.hash.replace(/^#/, "")).get("gid");
    return gid ? `${out}&gid=${encodeURIComponent(gid)}` : out;
  }

  // Hugging Face: [datasets|spaces/]<owner>/<repo>/blob/<ref>/<path> -> .../resolve/...
  if (host === "huggingface.co" || host === "www.huggingface.co") {
    const offset = segs[0] === "datasets" || segs[0] === "spaces" ? 1 : 0;
    const idx = offset + 2;
    if (segs.length > idx + 2 && segs[idx] === "blob") {
      const out = [...segs];
      out[idx] = "resolve";
      return `https://huggingface.co/${out.join("/")}`;
    }
  }

  // Dropbox: ?dl=0 (the preview page) -> ?dl=1 (the file)
  if (host === "www.dropbox.com" || host === "dropbox.com") {
    if (u.searchParams.get("dl") !== "1") {
      u.searchParams.set("dl", "1");
      return u.toString();
    }
  }

  return input;
}
