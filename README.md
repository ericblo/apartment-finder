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

`src/floorplan/` is a per-apartment floor plan editor — reached by clicking an apartment on the apartments list (`src/apartments/apartments.html`), which opens `floorplan.html?apartment=<id>`. Each apartment has its own set of room rectangles.

Rooms are always axis-aligned — stored as `{ min: [x, y], max: [x, y] }`, never an arbitrary rotation or 4 free-form points. This is enforced automatically wherever rooms are created, both by the extraction pipeline and by every edit in the browser editor.

```
npm run floorplan
```

Then open http://localhost:4173/src/apartments/apartments.html and click an apartment. Click "Enable editing" to:
- **Drag inside a room** to move the whole rectangle (translation only, edges stay axis-aligned).
- **Drag a corner or edge handle** to resize that room (adjusts one or two coordinates directly — never a rotation).
- **Click a label** to rename a room.
- **"Delete apartment"** (top of the page) removes the apartment from the list and its floor plan data, and goes back to the apartments list. This can't be undone.

A brand new apartment (added via "+" on the list, no floor plan yet) opens with a single starter room you can resize/rename — there's currently no "add another room" button, so more rooms have to come from the LiDAR pipeline below or manual data edits.

Each edit saves automatically, keyed by apartment id, to `src/floorplan/apartment_floorplans.json` via a small local Node server (`src/floorplan/server.js`) when running locally.

This server also serves the item finder (`index.html`) and the apartments list from the same origin, so `npm run floorplan` is the easiest way to run the whole app locally — all pages link to each other.

### Saving from the live GitHub Pages site

GitHub Pages is static hosting — it can't run `server.js`, so the deployed editor saves straight to Supabase instead, using a public row per apartment (keyed by `apartment_id`) in the `floorplan_state` table — same mechanism as the apartments list's `apartments_state` table below.

**One-time setup:** `floorplan_state` currently has a single fixed row (`id = 1`, the pre-existing data for "Mateo & Eric's place") from before floor plans were per-apartment. Migrate it to be keyed by `apartment_id` by running this once in the Supabase project's SQL editor:

```sql
alter table floorplan_state add column apartment_id text unique;
update floorplan_state set apartment_id = 'b6f5a3a0-1d2e-4c5a-8b1a-5f7e6c9d0a11' where id = 1;
alter table floorplan_state alter column apartment_id set not null;
```

(That id is "Mateo & Eric's place" from `src/apartments/apartments.json` — check it still matches before running this if the seed data has changed.) Existing row-level security policies should already permit the anon key to read/write; no changes needed there.

Locally (`npm run floorplan`), none of this applies — saves go through `server.js` and `apartment_floorplans.json` instead.

**"Clean up layout"** is a separate, manual, on-demand button (never runs automatically) that does two things in sequence:
1. Rotates the whole layout so the largest room's longest edge is vertical.
2. Snaps any two rooms' edges that are within ~0.18m of touching to align exactly (averages the coordinate), so adjacent walls read as flush.

Dragging never snaps on its own — if edges drift apart after moving rooms around, re-run "Clean up layout."

Known limitation, not auto-fixed: rooms connected by an open doorway in the raw scan merge into a single rectangle (currently `room_1`, spanning the living room and an adjacent room). Splitting a merged rectangle into two isn't built yet.

`src/floorplan/floorplan_data.json` (the old polygon-based floor plan) is no longer read by the app — kept only as a reference/backup.

## Apartments

`src/apartments/` lists every apartment you've added and lets you add a new one (`apartments.html` / `add-apartment.html`). It follows the exact same local-server-vs-Supabase pattern as the floor plan editor above, just with its own table (`apartments_state`) and its own single JSON row. Locally it reads/writes `src/apartments/apartments.json`; on static hosting it upserts to Supabase via the same public row convention as `floorplan_state`.

**One-time setup:** the `apartments_state` table doesn't exist in the Supabase project yet, so saves from the deployed (non-local) site will fail until it's created. Run this once in the Supabase project's SQL editor:

```sql
create table apartments_state (
  id bigint primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

alter table apartments_state enable row level security;

create policy "public read" on apartments_state for select using (true);
create policy "public upsert" on apartments_state for insert with check (true);
create policy "public update" on apartments_state for update using (true);
```

Locally (`npm run floorplan`), none of this is needed — saves go through `server.js` and `apartments.json` instead.

### Regenerating the floor plan from the LiDAR scan

`pipeline/extract_rect_rooms.py` derives `rect_rooms.json` (plus `wall_raster.png` and `raster_params.npy`, also in `src/floorplan/`) from `scan.glb`:

```
pip install -r pipeline/requirements.txt
python3 pipeline/extract_rect_rooms.py
```

It projects the mesh onto the floor plane within a wall-height band, finds the building envelope, and fits a rectangle (`cv2.minAreaRect`) to each enclosed free-space blob — then rotates the whole layout so the largest room's longest edge is vertical and takes each room's axis-aligned bounding box in that frame (the same "rotate to vertical" logic as the editor's cleanup button, applied once at extraction time since axis-alignment is mandatory for the stored data). This favors "a reasonable rectangle per room" over pixel-perfect walls.

The pipeline only knows about `scan.glb` for the one apartment that's been scanned — it writes its result to `src/floorplan/rect_rooms.json`, not into the per-apartment `apartment_floorplans.json` the app actually reads. After re-running the pipeline, copy `rect_rooms.json`'s contents into `apartment_floorplans.json` under that apartment's id by hand if you want the app to pick up the re-extraction — this overwrites any manual edits made in the browser editor for that apartment, so re-extract before you start editing, not after.
