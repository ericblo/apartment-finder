#!/usr/bin/env python3
"""Extract rectangular room footprints from a LiDAR scan (scan.glb).

Pipeline:
  1. Load the mesh and find its up-axis (smallest bounding-box extent).
  2. Project all faces within a "wall-height band" onto the floor plane and
     fill them, producing a dense occupancy silhouette. A single-height
     cross-section was tried first but had a large hole where the scan
     didn't capture a reflective/glass surface at that exact height; the
     band-projection is robust to that since most walls have coverage
     *somewhere* in their height range.
  3. Take the silhouette's largest connected blob, fill it solid -> this is
     the building envelope, used as a hard clipping mask so free-space
     detection can never leak past the true exterior wall regardless of
     small gaps in the raster.
  4. Free space = NOT(silhouette) AND envelope. Connected components on
     that gives one blob per enclosed room (walls *and* large furniture
     act as separators).
  5. cv2.minAreaRect per blob -> a best-fit (possibly rotated) rectangle.
  6. Auto-rotate the whole layout so the longest edge of the largest room
     is vertical (rotating every room's corners around the shared centroid
     of all room centers), then take each room's axis-aligned bounding box
     in that rotated frame. Rooms are stored as axis-aligned (min, max)
     corners only -- never an arbitrary rotation -- so this step is not
     optional, it's how axis-alignment gets enforced at extraction time.

This favors "a reasonable rectangle per room" over pixel-perfect walls —
some blobs will be smaller than the true room (furniture eats into the
free-space contour) and some may include a doorway gap merging two rooms.
Both are expected; fix up boundaries by hand in the floor plan editor
rather than by tuning this pipeline further.

Outputs (written to src/floorplan/):
  rect_rooms.json    - room rectangles consumed by the app
  wall_raster.png    - the closed occupancy silhouette, for visual debugging
  raster_params.npy  - transform params tying pixel space back to world meters
"""

import json
import math
from pathlib import Path

import cv2
import numpy as np
import trimesh

REPO_ROOT = Path(__file__).resolve().parent.parent
SCAN_PATH = REPO_ROOT / "scan.glb"
OUT_DIR = REPO_ROOT / "src" / "floorplan"

RESOLUTION_M_PER_PX = 0.02       # 2cm/pixel raster resolution
PADDING_PX = 10                  # raster padding around mesh bounds
BAND_LOW_FRAC = 0.15 / 1.0       # placeholder, actual band computed from floor/ceiling below (see main)
SILHOUETTE_CLOSE_KERNEL_PX = 7   # closes small scan-noise gaps in the occupancy silhouette
MIN_ROOM_AREA_M2 = 2.0           # discard tiny noise components


def load_mesh():
    scene = trimesh.load(SCAN_PATH)
    if isinstance(scene, trimesh.Scene):
        meshes = [g for g in scene.geometry.values() if isinstance(g, trimesh.Trimesh)]
        return trimesh.util.concatenate(meshes)
    return scene


def find_up_axis(mesh):
    extents = mesh.bounds[1] - mesh.bounds[0]
    axis = int(np.argmin(extents))
    plane_axes = [i for i in range(3) if i != axis]
    return axis, plane_axes


def raster_extent(mesh, plane_axes):
    verts = mesh.vertices[:, plane_axes]
    min_xz = (float(verts[:, 0].min()), float(verts[:, 1].min()))
    max_xz = (float(verts[:, 0].max()), float(verts[:, 1].max()))
    width_px = int(np.ceil((max_xz[0] - min_xz[0]) / RESOLUTION_M_PER_PX)) + PADDING_PX * 2
    height_px = int(np.ceil((max_xz[1] - min_xz[1]) / RESOLUTION_M_PER_PX)) + PADDING_PX * 2
    return min_xz, max_xz, width_px, height_px


def to_px(pt_xz, min_xz):
    x = int(round((pt_xz[0] - min_xz[0]) / RESOLUTION_M_PER_PX)) + PADDING_PX
    z = int(round((pt_xz[1] - min_xz[1]) / RESOLUTION_M_PER_PX)) + PADDING_PX
    return x, z


def px_to_world(pt_px, min_xz):
    x = (pt_px[0] - PADDING_PX) * RESOLUTION_M_PER_PX + min_xz[0]
    z = (pt_px[1] - PADDING_PX) * RESOLUTION_M_PER_PX + min_xz[1]
    return [float(x), float(z)]


def build_silhouette(mesh, up_axis, plane_axes, min_xz, width_px, height_px):
    up_vals = mesh.vertices[:, up_axis]
    floor = float(up_vals.min())
    ceiling = float(up_vals.max())
    band_lo = floor + 0.15
    band_hi = floor + 0.85 * (ceiling - floor)

    verts_up = mesh.vertices[:, up_axis]
    v_in_band = (verts_up >= band_lo) & (verts_up <= band_hi)
    face_mask = v_in_band[mesh.faces].all(axis=1)
    sel_faces = mesh.faces[face_mask]

    silhouette = np.zeros((height_px, width_px), dtype=np.uint8)
    tri_xz = mesh.vertices[sel_faces][:, :, plane_axes]
    tri_px = np.empty_like(tri_xz, dtype=np.int32)
    tri_px[:, :, 0] = np.round((tri_xz[:, :, 0] - min_xz[0]) / RESOLUTION_M_PER_PX) + PADDING_PX
    tri_px[:, :, 1] = np.round((tri_xz[:, :, 1] - min_xz[1]) / RESOLUTION_M_PER_PX) + PADDING_PX
    for tri in tri_px:
        cv2.fillConvexPoly(silhouette, tri, 255)

    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (SILHOUETTE_CLOSE_KERNEL_PX,) * 2)
    closed = cv2.morphologyEx(silhouette, cv2.MORPH_CLOSE, kernel)
    return closed, floor, ceiling, band_lo, band_hi


def building_envelope(closed_silhouette):
    h, w = closed_silhouette.shape
    num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(closed_silhouette, connectivity=8)
    largest_label = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    largest_blob = np.where(labels == largest_label, 255, 0).astype(np.uint8)

    contours, _ = cv2.findContours(largest_blob, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    largest_contour = max(contours, key=cv2.contourArea)
    filled = np.zeros((h, w), dtype=np.uint8)
    cv2.drawContours(filled, [largest_contour], -1, 255, thickness=cv2.FILLED)
    return filled


def extract_room_rects(closed_silhouette, envelope_filled, min_xz):
    free = cv2.bitwise_and(cv2.bitwise_not(closed_silhouette), envelope_filled)
    num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(free, connectivity=4)
    min_area_px = MIN_ROOM_AREA_M2 / (RESOLUTION_M_PER_PX ** 2)

    rooms = []
    for label in range(1, num_labels):
        area_px = stats[label, cv2.CC_STAT_AREA]
        if area_px < min_area_px:
            continue

        mask = np.where(labels == label, 255, 0).astype(np.uint8)
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            continue
        largest = max(contours, key=cv2.contourArea)

        (cx_px, cz_px), (w_px, h_px), angle_deg = cv2.minAreaRect(largest)
        box_px = cv2.boxPoints(((cx_px, cz_px), (w_px, h_px), angle_deg))

        corners = [px_to_world(pt, min_xz) for pt in box_px]
        center = px_to_world((cx_px, cz_px), min_xz)
        width_m = w_px * RESOLUTION_M_PER_PX
        height_m = h_px * RESOLUTION_M_PER_PX

        rooms.append({
            "corners": corners,
            "center": center,
            "width": round(width_m, 4),
            "height": round(height_m, 4),
            "angle_deg": round(float(angle_deg), 4),
            "area_m2": round(area_px * (RESOLUTION_M_PER_PX ** 2), 3),
        })

    rooms.sort(key=lambda r: r["area_m2"], reverse=True)
    for i, room in enumerate(rooms, start=1):
        room["id"] = f"room_{i}"
        room["name"] = f"Room {i}"

    return rooms


def normalize_angle(angle):
    """Fold an angle into (-pi/2, pi/2] -- a rectangle's long-edge direction
    is symmetric under 180-degree rotation, so this picks the smaller turn."""
    while angle > math.pi / 2:
        angle -= math.pi
    while angle <= -math.pi / 2:
        angle += math.pi
    return angle


def rotate_point(pt, centroid, angle):
    dx = pt[0] - centroid[0]
    dy = pt[1] - centroid[1]
    c, s = math.cos(angle), math.sin(angle)
    return (centroid[0] + dx * c - dy * s, centroid[1] + dx * s + dy * c)


def longest_edge_direction(corners):
    """Derive the long-edge direction straight from the corner coordinates
    rather than trusting cv2.minAreaRect's angle convention (which varies by
    OpenCV version) or assuming width/height map to specific world axes."""
    best_len = -1.0
    best_dir = (1.0, 0.0)
    for i in range(4):
        p0, p1 = corners[i], corners[(i + 1) % 4]
        dx, dy = p1[0] - p0[0], p1[1] - p0[1]
        length = math.hypot(dx, dy)
        if length > best_len:
            best_len = length
            best_dir = (dx, dy)
    return best_dir


def auto_rotate_and_axis_align(rooms):
    """Rotate every room so the largest room's longest edge is vertical, then
    take each room's axis-aligned bounding box in that frame. This is how
    axis-alignment (a hard constraint on the stored data) gets enforced."""
    if not rooms:
        return []

    largest = max(rooms, key=lambda r: r["area_m2"])
    direction = longest_edge_direction(largest["corners"])
    edge_angle = math.atan2(direction[1], direction[0])
    rotation = normalize_angle(math.pi / 2 - edge_angle)

    centroid = (
        sum(r["center"][0] for r in rooms) / len(rooms),
        sum(r["center"][1] for r in rooms) / len(rooms),
    )

    aligned = []
    for room in rooms:
        if abs(rotation) > 1e-9:
            rotated_corners = [rotate_point(c, centroid, rotation) for c in room["corners"]]
        else:
            rotated_corners = room["corners"]
        xs = [c[0] for c in rotated_corners]
        ys = [c[1] for c in rotated_corners]
        aligned.append({
            "id": room["id"],
            "name": room["name"],
            "min": [round(min(xs), 4), round(min(ys), 4)],
            "max": [round(max(xs), 4), round(max(ys), 4)],
        })

    return aligned, math.degrees(rotation)


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    print(f"Loading {SCAN_PATH.name}...")
    mesh = load_mesh()
    print(f"  {len(mesh.vertices)} vertices, {len(mesh.faces)} faces")

    up_axis, plane_axes = find_up_axis(mesh)
    print(f"  up-axis: {'xyz'[up_axis]}, floor-plan plane: {[('xyz'[a]) for a in plane_axes]}")

    min_xz, max_xz, width_px, height_px = raster_extent(mesh, plane_axes)
    print(f"  raster size: {width_px}x{height_px}px at {RESOLUTION_M_PER_PX}m/px")

    print("Building occupancy silhouette (wall-height band projection)...")
    closed_sil, floor, ceiling, band_lo, band_hi = build_silhouette(
        mesh, up_axis, plane_axes, min_xz, width_px, height_px
    )
    print(f"  floor={floor:.2f} ceiling={ceiling:.2f} band=[{band_lo:.2f}, {band_hi:.2f}]")

    print("Finding building envelope...")
    envelope_filled = building_envelope(closed_sil)
    print(f"  envelope area: {(envelope_filled > 0).sum() * RESOLUTION_M_PER_PX ** 2:.1f}m2")

    cv2.imwrite(str(OUT_DIR / "wall_raster.png"), closed_sil)

    print("Finding room rectangles...")
    raw_rooms = extract_room_rects(closed_sil, envelope_filled, min_xz)
    print(f"  found {len(raw_rooms)} rooms:")
    for room in raw_rooms:
        print(f"    {room['id']}: {room['width']:.2f}m x {room['height']:.2f}m, "
              f"area {room['area_m2']:.1f}m2, angle {room['angle_deg']:.1f} deg")

    print("Auto-rotating layout to vertical and axis-aligning...")
    rooms, rotation_deg = auto_rotate_and_axis_align(raw_rooms)
    print(f"  rotated whole layout by {rotation_deg:.1f} deg")
    for room in rooms:
        w = room["max"][0] - room["min"][0]
        h = room["max"][1] - room["min"][1]
        print(f"    {room['id']}: {w:.2f}m x {h:.2f}m (axis-aligned)")

    params = {
        "source": str(SCAN_PATH.name),
        "up_axis": "xyz"[up_axis],
        "plane_axes": ["xyz"[a] for a in plane_axes],
        "floor": floor,
        "ceiling": ceiling,
        "wall_band": [band_lo, band_hi],
        "resolution_m_per_px": RESOLUTION_M_PER_PX,
        "padding_px": PADDING_PX,
        "min_xz": list(min_xz),
        "max_xz": list(max_xz),
        "raster_width_px": width_px,
        "raster_height_px": height_px,
        "silhouette_close_kernel_px": SILHOUETTE_CLOSE_KERNEL_PX,
        "auto_rotation_deg": rotation_deg,
    }
    np.save(OUT_DIR / "raster_params.npy", params, allow_pickle=True)

    output = {
        "coordinate_frame": {
            "unit": "meters",
            "note": (
                "Rotated so the largest room's longest edge is vertical; not tied "
                "to compass orientation. Rooms are axis-aligned rectangles (min, "
                "max corners) -- always, never an arbitrary rotation. Rectangles "
                "are approximate (furniture and open doorways can shrink/merge "
                "blobs) -- fix up by hand in the floor plan editor."
            ),
        },
        "rooms": rooms,
    }
    with open(OUT_DIR / "rect_rooms.json", "w") as f:
        json.dump(output, f, indent=2)
        f.write("\n")

    print(f"\nWrote {OUT_DIR / 'rect_rooms.json'}")
    print(f"Wrote {OUT_DIR / 'wall_raster.png'}")
    print(f"Wrote {OUT_DIR / 'raster_params.npy'}")


if __name__ == "__main__":
    main()
