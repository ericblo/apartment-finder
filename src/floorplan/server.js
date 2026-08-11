#!/usr/bin/env node

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 4173;
const ROOT = path.join(__dirname, "..", "..");
const DATA_FILE = path.join(__dirname, "rect_rooms.json");

const MIME_TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
};

function serveStatic(req, res, urlPath) {
  const relativePath = urlPath === "/" ? "src/floorplan/floorplan.html" : urlPath.slice(1);
  const filePath = path.join(ROOT, relativePath);

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(content);
  });
}

function handleGetFloorplan(req, res) {
  fs.readFile(DATA_FILE, "utf8", (err, content) => {
    if (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(content);
  });
}

function handleSaveFloorplan(req, res) {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 5_000_000) {
      req.destroy();
    }
  });

  req.on("end", () => {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    if (!parsed || !Array.isArray(parsed.rooms)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Expected { rooms }" }));
      return;
    }

    fs.writeFile(DATA_FILE, JSON.stringify(parsed, null, 2) + "\n", (err) => {
      if (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
}

const server = http.createServer((req, res) => {
  const urlPath = req.url.split("?")[0];

  if (urlPath === "/api/floorplan" && req.method === "GET") {
    handleGetFloorplan(req, res);
    return;
  }

  if (urlPath === "/api/floorplan" && req.method === "POST") {
    handleSaveFloorplan(req, res);
    return;
  }

  serveStatic(req, res, urlPath);
});

server.listen(PORT, () => {
  console.log(`Floor plan editor running at http://localhost:${PORT}/`);
});
