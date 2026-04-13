// api/trigger-sync.js
// Vercel serverless function — triggert de GitHub Actions garmin_sync workflow
// Vereiste Vercel env vars:
//   GITHUB_PAT  → fine-grained PAT met "Actions: Write" op Gkornet/Gkoach
//   GITHUB_REPO → "Gkornet/Gkoach"  (of hardcoded hieronder)

export default async function handler(req, res) {
  // Alleen POST toestaan
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const pat  = process.env.GITHUB_PAT;
  const repo = process.env.GITHUB_REPO || "Gkornet/Gkoach";

  if (!pat) {
    return res.status(500).json({ error: "GITHUB_PAT niet geconfigureerd" });
  }

  try {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/garmin_sync.yml/dispatches`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${pat}`,
          "Accept": "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ref: "main" }),
      }
    );

    if (response.status === 204) {
      return res.status(200).json({ ok: true, message: "Sync gestart" });
    } else {
      const body = await response.text();
      return res.status(response.status).json({ error: body });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
