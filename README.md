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

`src/floorplan/` holds the apartment's floor plan as room rectangles (`rect_rooms.json`, in meters) plus a small editor for editing them.

Rooms are always axis-aligned — stored as `{ min: [x, y], max: [x, y] }`, never an arbitrary rotation or 4 free-form points. This is enforced automatically wherever rooms are created, both by the extraction pipeline and by every edit in the browser editor.

```
npm run floorplan
```

Then open http://localhost:4173/. Click "Enable editing" to:
- **Drag inside a room** to move the whole rectangle (translation only, edges stay axis-aligned).
- **Drag a corner or edge handle** to resize that room (adjusts one or two coordinates directly — never a rotation).
- **Click a label** to rename a room.

Each edit saves automatically to `src/floorplan/rect_rooms.json` via a small local Node server (`src/floorplan/server.js`) when running locally.

This server also serves the item finder (`index.html`) from the same origin, so `npm run floorplan` is the easiest way to run the whole app locally — both pages link to each other ("Edit floor plan" / "Item Finder").

### Saving from the live GitHub Pages site

GitHub Pages is static hosting — it can't run `server.js`, so the deployed editor at https://ericblo.github.io/apartment-finder/src/floorplan/floorplan.html saves a different way: it commits `rect_rooms.json` directly to the repo via the GitHub Contents API, using a Personal Access Token you provide.

On first visit to the non-local page, a token panel appears above the floor plan. Paste in a token and click "Save token" — it's stored only in that browser's `localStorage`, never in the deployed source. Use a **fine-grained token scoped to just this repo** with "Contents: Read and write" permission (not a broad classic token), and revoke it from GitHub's token settings whenever you want to cut off access. Each save while editing there becomes a real commit on `main`, which also triggers a Pages rebuild — so the live page reflects your latest edit within a minute or two.

Locally (`npm run floorplan`), none of this applies — saves go through `server.js` as before and the token panel stays hidden.

**"Clean up layout"** is a separate, manual, on-demand button (never runs automatically) that does two things in sequence:
1. Rotates the whole layout so the largest room's longest edge is vertical.
2. Snaps any two rooms' edges that are within ~0.18m of touching to align exactly (averages the coordinate), so adjacent walls read as flush.

Dragging never snaps on its own — if edges drift apart after moving rooms around, re-run "Clean up layout."

Known limitation, not auto-fixed: rooms connected by an open doorway in the raw scan merge into a single rectangle (currently `room_1`, spanning the living room and an adjacent room). Splitting a merged rectangle into two isn't built yet.

`src/floorplan/floorplan_data.json` (the old polygon-based floor plan) is no longer read by the app — kept only as a reference/backup.

### Regenerating the floor plan from the LiDAR scan

`pipeline/extract_rect_rooms.py` derives `rect_rooms.json` (plus `wall_raster.png` and `raster_params.npy`, also in `src/floorplan/`) from `scan.glb`:

```
pip install -r pipeline/requirements.txt
python3 pipeline/extract_rect_rooms.py
```

It projects the mesh onto the floor plane within a wall-height band, finds the building envelope, and fits a rectangle (`cv2.minAreaRect`) to each enclosed free-space blob — then rotates the whole layout so the largest room's longest edge is vertical and takes each room's axis-aligned bounding box in that frame (the same "rotate to vertical" logic as the editor's cleanup button, applied once at extraction time since axis-alignment is mandatory for the stored data). This favors "a reasonable rectangle per room" over pixel-perfect walls — re-running it overwrites any manual edits made in the browser editor, so re-extract before you start editing, not after.
