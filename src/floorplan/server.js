#!/usr/bin/env node

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 4173;
const ROOT = path.join(__dirname, "..", "..");
// Per-apartment floor plans, keyed by apartment id: { "<id>": { rooms: [...] } }.
// rect_rooms.json (the LiDAR pipeline's raw output) is no longer read directly --
// its content was migrated in here once. Re-running the pipeline still refreshes
// rect_rooms.json; copy the result into this file under the apartment's id by hand
// if you want the app to pick up a re-extraction.
const APARTMENT_FLOORPLANS_FILE = path.join(__dirname, "apartment_floorplans.json");
const DEFAULT_FLOORPLAN_DATA = { rooms: [{ id: "room_1", name: "New Room", min: [0, 0], max: [5, 5] }] };
const APARTMENTS_DATA_FILE = path.join(__dirname, "..", "apartments", "apartments.json");

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

function readFloorplanStore() {
  return new Promise((resolve) => {
    fs.readFile(APARTMENT_FLOORPLANS_FILE, "utf8", (err, content) => {
      if (err) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(content));
      } catch (parseErr) {
        resolve({});
      }
    });
  });
}

function handleGetFloorplan(req, res, apartmentId) {
  readFloorplanStore().then((store) => {
    const data = store[apartmentId] || DEFAULT_FLOORPLAN_DATA;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  });
}

function handleSaveFloorplan(req, res, apartmentId) {
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

    readFloorplanStore().then((store) => {
      store[apartmentId] = parsed;
      fs.writeFile(APARTMENT_FLOORPLANS_FILE, JSON.stringify(store, null, 2) + "\n", (err) => {
        if (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
  });
}

function handleDeleteFloorplan(req, res, apartmentId) {
  readFloorplanStore().then((store) => {
    delete store[apartmentId];
    fs.writeFile(APARTMENT_FLOORPLANS_FILE, JSON.stringify(store, null, 2) + "\n", (err) => {
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

function handleGetApartments(req, res) {
  fs.readFile(APARTMENTS_DATA_FILE, "utf8", (err, content) => {
    if (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(content);
  });
}

function handleSaveApartments(req, res) {
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

    if (!parsed || !Array.isArray(parsed.apartments)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Expected { apartments }" }));
      return;
    }

    fs.writeFile(APARTMENTS_DATA_FILE, JSON.stringify(parsed, null, 2) + "\n", (err) => {
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
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const urlPath = requestUrl.pathname;

  if (urlPath === "/api/floorplan" && req.method === "GET") {
    const apartmentId = requestUrl.searchParams.get("apartment");
    if (!apartmentId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing apartment query param" }));
      return;
    }
    handleGetFloorplan(req, res, apartmentId);
    return;
  }

  if (urlPath === "/api/floorplan" && req.method === "POST") {
    const apartmentId = requestUrl.searchParams.get("apartment");
    if (!apartmentId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing apartment query param" }));
      return;
    }
    handleSaveFloorplan(req, res, apartmentId);
    return;
  }

  if (urlPath === "/api/floorplan" && req.method === "DELETE") {
    const apartmentId = requestUrl.searchParams.get("apartment");
    if (!apartmentId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing apartment query param" }));
      return;
    }
    handleDeleteFloorplan(req, res, apartmentId);
    return;
  }

  if (urlPath === "/api/apartments" && req.method === "GET") {
    handleGetApartments(req, res);
    return;
  }

  if (urlPath === "/api/apartments" && req.method === "POST") {
    handleSaveApartments(req, res);
    return;
  }

  serveStatic(req, res, urlPath);
});

server.listen(PORT, () => {
  console.log(`Floor plan editor running at http://localhost:${PORT}/`);
});
