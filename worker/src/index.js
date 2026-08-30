/**
 * Palisade update + feedback Worker.
 *
 * The app repo is private, so Tauri's usual trick — a static latest.json at
 * a public GitHub URL — 404s for testers. This Worker holds the credentials
 * instead: it authenticates to GitHub and Hugging Face, and hands the app
 * back exactly the shapes it expects.
 *
 * Routes:
 *   GET  /latest.json      Tauri updater manifest for the newest release
 *   GET  /download/:id     a private release asset
 *   GET  /models.json      which model this app version should be running
 *   GET  /model/:role      the model file for one role (fim, ...)
 *   POST /feedback         a tester's report, filed as a GitHub issue
 *   GET  /health           liveness, no credentials touched
 *
 * Large files are never buffered here: both GitHub and Hugging Face answer
 * an authenticated request with a signed redirect, and we pass that straight
 * to the client so the bytes skip Cloudflare entirely. If a signed redirect
 * ever stops coming back, we stream instead — correct either way.
 */

const GITHUB_API = "https://api.github.com";
const HF_HOST = "https://huggingface.co";
const UA = "palisade-updates-worker";

const MAX_TITLE = 200;
const MAX_BODY = 60_000;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") return preflight();

    try {
      if (request.method === "GET" && path === "/health") {
        return json({ ok: true });
      }
      if (request.method === "GET" && path === "/latest.json") {
        return await latestManifest(env, url.origin);
      }
      if (request.method === "GET" && path.startsWith("/download/")) {
        return await downloadAsset(env, path.slice("/download/".length));
      }
      if (request.method === "GET" && path === "/models.json") {
        return await modelManifest(env, url.origin);
      }
      if (request.method === "GET" && path.startsWith("/model/")) {
        return await modelFile(env, path.slice("/model/".length));
      }
      if (request.method === "POST" && path === "/feedback") {
        return await fileFeedback(request, env, ctx);
      }
      return json({ error: "not found" }, 404);
    } catch (err) {
      // Never let an upstream error message reach the client: GitHub and HF
      // put tokens and signed URLs in some of them.
      console.error(path, err && err.stack ? err.stack : String(err));
      return json({ error: "upstream request failed" }, 502);
    }
  },
};

/* -------------------------------------------------------- updates -------- */

/**
 * Builds Tauri's updater manifest from a GitHub release.
 *
 * Pure so it can be tested without network: see test.mjs.
 */
export function buildUpdateManifest(release, target, origin, signature) {
  const archive = release.assets.find((a) => a.name.endsWith(".app.tar.gz"));
  if (!archive) throw new Error("release has no .app.tar.gz asset");

  return {
    version: String(release.tag_name || "").replace(/^v/, ""),
    notes: release.body || "",
    pub_date: release.published_at || new Date().toISOString(),
    platforms: {
      [target]: {
        signature,
        url: `${origin}/download/${archive.id}`,
      },
    },
  };
}

async function latestManifest(env, origin) {
  // Not /releases/latest: that endpoint skips prereleases, and every beta
  // build is one.
  const releases = await gh(env, `/repos/${env.GITHUB_REPO}/releases?per_page=10`);
  const release = releases.find((r) => !r.draft);
  if (!release) return json({ error: "no published release" }, 404);

  const sigAsset = release.assets.find((a) => a.name.endsWith(".app.tar.gz.sig"));
  if (!sigAsset) return json({ error: "release has no .sig asset" }, 500);

  // Tauri wants the signature inline, not as a URL.
  const signature = (await assetBody(env, sigAsset.id)).trim();

  return json(buildUpdateManifest(release, env.UPDATE_TARGET, origin, signature), 200, {
    // Testers check on launch and every 30 minutes; a short cache keeps a
    // burst of restarts off the GitHub API without delaying a release.
    "cache-control": "public, max-age=60",
  });
}

async function downloadAsset(env, id) {
  if (!/^\d+$/.test(id)) return json({ error: "bad asset id" }, 400);

  const response = await fetch(`${GITHUB_API}/repos/${env.GITHUB_REPO}/releases/assets/${id}`, {
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: "application/octet-stream",
      "user-agent": UA,
    },
    redirect: "manual",
  });
  return passThrough(response, "release asset");
}

/* --------------------------------------------------------- model --------- */

/**
 * Parses the MODELS table from wrangler.toml into role -> entry.
 *
 * A table beats one var per field: adding the second model is a line, and a
 * half-configured row is visible at a glance.
 *
 * Pure so it can be tested without network: see test.mjs.
 */
export function parseModels(table) {
  const models = {};
  for (const line of String(table || "").split("\n")) {
    const row = line.trim();
    if (!row || row.startsWith("#")) continue;

    const [role, path, sha256, size, minAppVersion] = row.split("|").map((c) => c.trim());
    if (!role || !path) continue;

    models[role] = {
      path,
      filename: path.split("/").pop(),
      sha256: sha256 || "",
      size: Number(size || 0),
      minAppVersion: minAppVersion || "",
    };
  }
  return models;
}

async function modelManifest(env, origin) {
  const models = parseModels(env.MODELS);
  const manifest = {};

  for (const [role, entry] of Object.entries(models)) {
    // An entry without a checksum is half-configured: publishing it would
    // hand the app a download it must reject anyway.
    if (!entry.sha256) continue;
    manifest[role] = {
      filename: entry.filename,
      sha256: entry.sha256,
      url: `${origin}/model/${role}`,
      size: entry.size,
      minAppVersion: entry.minAppVersion,
    };
  }

  if (Object.keys(manifest).length === 0) {
    return json({ error: "no model is fully configured yet" }, 503);
  }
  return json(manifest, 200, { "cache-control": "public, max-age=300" });
}

async function modelFile(env, role) {
  if (!env.HF_REPO) return json({ error: "model host not configured" }, 503);

  const entry = parseModels(env.MODELS)[role];
  if (!entry) return json({ error: `unknown model role "${role}"` }, 404);

  // Encode per segment: the path contains slashes that must survive.
  const path = entry.path.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(`${HF_HOST}/${env.HF_REPO}/resolve/main/${path}`, {
    headers: { authorization: `Bearer ${env.HF_TOKEN}`, "user-agent": UA },
    redirect: "manual",
  });
  return passThrough(response, "model file");
}

/* ------------------------------------------------------- feedback -------- */

async function fileFeedback(request, env, ctx) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const { success } = await env.FEEDBACK_LIMIT.limit({ key: ip });
  if (!success) {
    return json({ error: "Too many reports too quickly. Try again in a moment." }, 429);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "body must be JSON" }, 400);
  }

  const title = String(payload.title || "").trim();
  const body = String(payload.body || "").trim();
  if (!title) return json({ error: "title is required" }, 400);

  const issue = await gh(env, `/repos/${env.GITHUB_REPO}/issues`, {
    method: "POST",
    body: JSON.stringify({
      title: title.slice(0, MAX_TITLE),
      body: body.slice(0, MAX_BODY),
      // Labels are applied here, not client-side: a tester's app should not
      // get to pick which bucket its report lands in.
      labels: ["beta-feedback"],
    }),
  });

  return json({ number: issue.number, url: issue.html_url }, 201);
}

/* --------------------------------------------------------- helpers ------- */

async function gh(env, path, init = {}) {
  const response = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "user-agent": UA,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub ${path} responded ${response.status}`);
  }
  return response.json();
}

async function assetBody(env, id) {
  const response = await fetch(`${GITHUB_API}/repos/${env.GITHUB_REPO}/releases/assets/${id}`, {
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: "application/octet-stream",
      "user-agent": UA,
    },
  });
  if (!response.ok) throw new Error(`asset ${id} responded ${response.status}`);
  return response.text();
}

/**
 * Hands a large upstream response to the client without buffering it.
 *
 * A signed redirect is forwarded as a redirect, so the bytes never transit
 * the Worker. Anything else is streamed through.
 */
function passThrough(response, what) {
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (location) return Response.redirect(location, 302);
  }
  if (!response.ok) {
    return json({ error: `${what} unavailable` }, response.status === 404 ? 404 : 502);
  }
  return new Response(response.body, {
    status: 200,
    headers: {
      "content-type": response.headers.get("content-type") || "application/octet-stream",
      ...(response.headers.get("content-length")
        ? { "content-length": response.headers.get("content-length") }
        : {}),
    },
  });
}

function json(value, status = 200, extra = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...cors(), ...extra },
  });
}

function cors() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  };
}

function preflight() {
  return new Response(null, { status: 204, headers: cors() });
}
