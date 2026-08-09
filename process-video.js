#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const Anthropic = require("@anthropic-ai/sdk");

const MODEL = "claude-sonnet-4-6";
const FRAME_INTERVAL_SECONDS = 2;
const ITEMS_FILE = path.join(__dirname, "items.json");

const ROOM_PROMPT = `This photo is from a video walkthrough of an apartment that only contains two possible rooms: 'Office' and 'Eric Bedroom'. First, decide which of those two rooms this photo was taken in, based on visible furniture and decor (an office has a desk/computer, a bedroom has a bed). Then list the distinct personal items visible in this photo (e.g. passport, keys, wallet, backpack, charger, phone, cables). Respond with ONLY valid JSON in this exact format: {"room": "Office" or "Eric Bedroom", "items": ["item1", "item2"]}. If no notable items are visible, use an empty array for items.`;

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function extractFrames(videoPath, outDir) {
  const pattern = path.join(outDir, "frame_%04d.jpg");
  try {
    execFileSync(
      "ffmpeg",
      [
        "-y",
        "-i", videoPath,
        "-vf", `fps=1/${FRAME_INTERVAL_SECONDS}`,
        "-q:v", "2",
        pattern,
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
  } catch (err) {
    fail(`ffmpeg failed to extract frames: ${err.message}`);
  }

  return fs
    .readdirSync(outDir)
    .filter((f) => f.toLowerCase().endsWith(".jpg"))
    .sort()
    .map((f) => path.join(outDir, f));
}

function stripCodeFences(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1] : trimmed;
}

async function analyzeFrame(client, framePath) {
  const imageBuffer = fs.readFileSync(framePath);
  const base64 = imageBuffer.toString("base64");

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg",
              data: base64,
            },
          },
          {
            type: "text",
            text: ROOM_PROMPT,
          },
        ],
      },
    ],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock) {
    throw new Error("No text content in response");
  }

  const jsonText = stripCodeFences(textBlock.text);
  const parsed = JSON.parse(jsonText);

  if (!parsed.room || !Array.isArray(parsed.items)) {
    throw new Error(`Unexpected response shape: ${jsonText}`);
  }

  return parsed;
}

function loadItemsFile() {
  if (!fs.existsSync(ITEMS_FILE)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(ITEMS_FILE, "utf8"));
  } catch (err) {
    fail(`Could not parse existing ${path.basename(ITEMS_FILE)}: ${err.message}`);
  }
}

function mostFrequentRoom(roomCounts) {
  let bestRoom = null;
  let bestCount = -1;
  for (const [room, count] of Object.entries(roomCounts)) {
    if (count > bestCount) {
      bestRoom = room;
      bestCount = count;
    }
  }
  return bestRoom;
}

async function main() {
  const videoPath = process.argv[2];
  if (!videoPath) {
    fail("Usage: node process-video.js <video-file-path>");
  }
  if (!fs.existsSync(videoPath)) {
    fail(`Video file not found: ${videoPath}`);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    fail("ANTHROPIC_API_KEY environment variable is not set.");
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-frames-"));
  let framePaths;

  try {
    console.log(`Extracting a frame every ${FRAME_INTERVAL_SECONDS}s from "${videoPath}"...`);
    framePaths = extractFrames(videoPath, tempDir);
    console.log(`Extracted ${framePaths.length} frame(s). Analyzing with Claude...\n`);

    // itemName (lowercased) -> { room -> count }
    const itemRoomCounts = {};
    const frameResults = [];

    for (const framePath of framePaths) {
      const frameName = path.basename(framePath);
      try {
        const { room, items } = await analyzeFrame(client, framePath);
        frameResults.push({ frameName, room, items });

        for (const rawItem of items) {
          const key = rawItem.trim().toLowerCase();
          if (!key) continue;
          if (!itemRoomCounts[key]) itemRoomCounts[key] = {};
          itemRoomCounts[key][room] = (itemRoomCounts[key][room] || 0) + 1;
        }
      } catch (err) {
        console.error(`  Warning: failed to analyze ${frameName}: ${err.message}`);
        frameResults.push({ frameName, room: null, items: [], error: err.message });
      }
    }

    const items = loadItemsFile();
    for (const [itemName, roomCounts] of Object.entries(itemRoomCounts)) {
      const room = mostFrequentRoom(roomCounts);
      if (room) {
        items[itemName] = room;
      }
    }

    fs.writeFileSync(ITEMS_FILE, JSON.stringify(items, null, 2) + "\n");

    console.log("--- Per-frame results ---");
    for (const result of frameResults) {
      if (result.error) {
        console.log(`${result.frameName}: ERROR (${result.error})`);
        continue;
      }
      const itemsText = result.items.length ? result.items.join(", ") : "(none)";
      console.log(`${result.frameName}: ${result.room} — items: ${itemsText}`);
    }

    console.log("\n--- Final item -> room mapping ---");
    const sortedItems = Object.keys(items).sort();
    if (sortedItems.length === 0) {
      console.log("(no items recorded)");
    } else {
      for (const itemName of sortedItems) {
        console.log(`${itemName} -> ${items[itemName]}`);
      }
    }

    console.log(`\nSaved to ${path.basename(ITEMS_FILE)}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  fail(err.message);
});
