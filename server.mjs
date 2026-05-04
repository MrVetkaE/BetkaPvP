import http from "node:http";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 8787);
const ROOT = __dirname;
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, "tier-data.json");

/** Должен совпадать с паролем в админке на фронте (или задай ADMIN_TOKEN в Render). */
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "MrBetka22867";

const CATEGORIES = [
  "Vanilla",
  "Sword",
  "Netherite",
  "Diamond Pot",
  "UHC",
  "Axe",
  "Mace",
  "Op",
  "SMP",
  "NetherPot"
];

const ALLOWED_TIERS = new Set([
  "HT1", "HT2", "HT3", "HT4", "HT5",
  "LT1", "LT2", "LT3", "LT4", "LT5"
]);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8"
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function text(res, code, body, type = "text/plain; charset=utf-8") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

function readBearer(req) {
  const h = req.headers.authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : "";
}

function safeJoin(root, reqPath) {
  const decoded = decodeURIComponent(reqPath.split("?")[0] || "/");
  const rel = decoded.replace(/^\/+/, "");
  const full = path.normalize(path.join(root, rel));
  if (!full.startsWith(path.normalize(root + path.sep)) && full !== path.normalize(root))
    return null;
  return full;
}

function isForbiddenFile(relPath) {
  const lower = relPath.replace(/\\/g, "/").toLowerCase();
  return (
    lower.startsWith(".git/") ||
    lower === "server.mjs" ||
    lower === "package.json" ||
    lower === "package-lock.json" ||
    lower.startsWith("node_modules/")
  );
}

function sanitizePayload(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new Error("Неверный JSON: ожидался объект");
  const out = {};
  for (const cat of CATEGORIES)
    out[cat] = [];
  if (Array.isArray(input.Dpot)) {
    for (const row of input.Dpot) pushRow(out["SMP"], row, "legacy Dpot");
  }
  for (const cat of CATEGORIES) {
    const arr = input[cat];
    if (!Array.isArray(arr)) continue;
    for (const row of arr) pushRow(out[cat], row, cat);
  }
  return out;
}

function pushRow(bucket, row, ctx) {
  if (!row || typeof row !== "object") return;
  let nick = String(row.nick || "").trim();
  let tier = String(row.tier || "").trim();
  if (!nick) return;
  if (!ALLOWED_TIERS.has(tier)) throw new Error(`Неверный тир у ${nick} (${ctx}): ${tier}`);
  bucket.push({ nick, tier });
}

async function readJsonFileIfExists() {
  try {
    const txt = await fsp.readFile(DATA_FILE, "utf8");
    return JSON.parse(txt);
  } catch (e) {
    if (e && e.code === "ENOENT") {
      const empty = {};
      for (const cat of CATEGORIES) empty[cat] = [];
      await writeJsonAtomic(empty);
      return empty;
    }
    throw e;
  }
}

let writeChain = Promise.resolve();

function writeJsonAtomic(data) {
  writeChain = writeChain.then(() => writeJsonAtomicImpl(data)).catch(() => {});
  return writeChain;
}

async function writeJsonAtomicImpl(data) {
  const dir = path.dirname(DATA_FILE);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = `${DATA_FILE}.${process.pid}.${Date.now()}.tmp`;
  const txt = `${JSON.stringify(data, null, 2)}\n`;
  await fsp.writeFile(tmp, txt, "utf8");
  await fsp.rename(tmp, DATA_FILE);
}

async function readBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("Тело запроса слишком большое");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return null;
  return JSON.parse(raw);
}

async function serveStatic(req, res, urlPath) {
  let rel = urlPath === "/" ? "/index.html" : urlPath;
  let filePath = safeJoin(ROOT, rel);
  if (!filePath)
    return text(res, 400, "Bad path");

  const relPosix = path.relative(ROOT, filePath).replace(/\\/g, "/");
  if (isForbiddenFile(relPosix))
    return text(res, 403, "Forbidden");

  try {
    const stat = await fsp.stat(filePath);
    if (stat.isDirectory()) {
      filePath = path.join(filePath, "index.html");
    }
    const ext = path.extname(filePath).toLowerCase();
    const ctype = MIME[ext] || "application/octet-stream";
    const data = await fsp.readFile(filePath);

    /** HTML лучше не кешировать из-за обновлений */
    const cache =
      ext === ".html"
        ? "no-store"
        : ext.match(/\.(png|jpg|jpeg|webp|gif|svg|ico|css|js)$/i)
          ? "public, max-age=31536000, immutable"
          : "public, max-age=60";

    res.writeHead(200, { "Content-Type": ctype, "Cache-Control": cache });
    res.end(data);
  } catch (e) {
    if (e && e.code === "ENOENT") {
      /** SPA fallback только для html-навигации */
      try {
        const idx = await fsp.readFile(path.join(ROOT, "index.html"));
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(idx);
      } catch {
        return text(res, 404, "Not found");
      }
    }
    return text(res, 500, "Server error");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const urlObj = new URL(req.url || "/", `http://${req.headers.host}`);
    const pathname = urlObj.pathname || "/";

    if (pathname === "/api/players") {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
          "Access-Control-Allow-Headers": "authorization, content-type",
          "Access-Control-Max-Age": "86400",
          "Cache-Control": "no-store"
        });
        return res.end();
      }

      if (req.method === "GET") {
        const data = await readJsonFileIfExists();
        return json(res, 200, sanitizePayload(data));
      }

      if (req.method === "PUT") {
        const token = readBearer(req);
        if (!token || token !== ADMIN_TOKEN)
          return json(res, 401, { error: "Unauthorized" });

        const body = await readBody(req, 2 * 1024 * 1024);
        const next = sanitizePayload(body);
        await writeJsonAtomic(next);
        return json(res, 200, { ok: true });
      }

      res.setHeader("Allow", "GET, PUT, OPTIONS");
      return text(res, 405, "Method not allowed");
    }

    /** Статические файлы */
    if (
      req.method !== "GET" &&
      req.method !== "HEAD"
    ) {
      return text(res, 405, "Method not allowed");
    }

    await serveStatic(req, res, pathname);
  } catch (e) {
    const msg =
      typeof e.message === "string" && /JSON/i.test(e.message || "")
        ? { error: `Bad JSON (${e.message})` }
        : { error: e.message || String(e) };
    return json(res, 400, msg);
  }
});

server.listen(PORT, () => {
  console.log(`BetkaPvP server listening on :${PORT}`);
  console.log(`DATA_FILE=${DATA_FILE}`);
});
