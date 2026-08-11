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

`src/floorplan/` holds the apartment's floor plan as room rectangles (`rect_rooms.json`, in meters) plus a small editor for resizing them.

```
npm run floorplan
```

Then open http://localhost:4173/. Click "Enable editing" to drag a room's corner or edge handles (resize only, preserves rectangularity — width/height/rotation, not free-form quads) or click a label to rename a room. Each edit saves automatically to `src/floorplan/rect_rooms.json` via a small local Node server (`src/floorplan/server.js`). This only works when running the server locally — the static GitHub Pages deployment has no backend to persist edits.

This server also serves the item finder (`index.html`) from the same origin, so `npm run floorplan` is the easiest way to run the whole app locally — both pages link to each other ("Edit floor plan" / "Item Finder").

Known limitation, not auto-fixed: rooms connected by an open doorway in the raw scan merge into a single rectangle (currently `room_1`, spanning the living room and an adjacent room). Splitting a merged rectangle into two isn't built yet — resize/rename only for now.

`src/floorplan/floorplan_data.json` (the old polygon-based floor plan) is no longer read by the app — kept only as a reference/backup.

### Regenerating the floor plan from the LiDAR scan

`pipeline/extract_rect_rooms.py` derives `rect_rooms.json` (plus `wall_raster.png` and `raster_params.npy`, also in `src/floorplan/`) from `scan.glb`:

```
pip install -r pipeline/requirements.txt
python3 pipeline/extract_rect_rooms.py
```

It projects the mesh onto the floor plane within a wall-height band, finds the building envelope, and fits a rectangle (`cv2.minAreaRect`) to each enclosed free-space blob. This favors "a reasonable rectangle per room" over pixel-perfect walls — re-running it overwrites any manual edits made in the browser editor, so re-extract before you start editing, not after.
