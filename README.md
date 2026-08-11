# Apartment Item Finder — Video Processor

`process-video.js` scans a video walkthrough of the apartment, pulls out a frame every 2 seconds, asks Claude to identify the room (Office or Eric Bedroom) and any personal items visible in each frame, and merges the results into `items.json` (item name -> room).

## Setup

1. Set your Anthropic API key as an environment variable:

   ```
   export ANTHROPIC_API_KEY=your-key-here
   ```

2. Install dependencies:

   ```
   npm install
   ```

   Note: this also requires `ffmpeg` to be installed and available on your `PATH` (e.g. `brew install ffmpeg`).

## Usage

```
node process-video.js walkthrough.mov
```

The script will:

1. Extract one frame every 2 seconds from the video into a temporary folder.
2. Send each frame to Claude (`claude-sonnet-4-6`) to guess the room and detect items.
3. Merge detected items into `items.json`, keeping whichever room each item was seen in most often.
4. Delete the temporary frame images.
5. Print a per-frame summary and the final item -> room mapping.

`items.json` is created in the project root if it doesn't already exist, and updated in place on each run.

## Floor Plan Editor

`src/floorplan/` holds the apartment's floor plan — room polygons (in meters, derived from a LiDAR scan) plus a small editor for reshaping them.

```
npm run floorplan
```

Then open http://localhost:4173/. Click "Enable editing" to drag room vertices; each edit is saved automatically to `src/floorplan/floorplan_data.json` via a small local Node server (`src/floorplan/server.js`). This only works when running the server locally — the static GitHub Pages deployment has no backend to persist edits.

This server also serves the item finder (`index.html`) from the same origin, so `npm run floorplan` is the easiest way to run the whole app locally — both pages link to each other ("Edit floor plan" / "Item Finder").
