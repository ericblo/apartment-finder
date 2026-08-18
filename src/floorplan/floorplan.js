const SVG_NS = "http://www.w3.org/2000/svg";
const SCALE = 40; // px per meter
const MARGIN = 24; // px padding around the plan
const MIN_ROOM_DIM_M = 0.1;
const SNAP_TOLERANCE_M = 0.18; // edges within this distance get pulled flush

const PALETTE = ["#f6c7a3", "#b7dd9a", "#f3b6d3", "#a9d1f0", "#e0c26f", "#c9b6f0"];

// Rooms are stored as axis-aligned rectangles: { min: [x, y], max: [x, y] }.
// Corner order: [bottom-left, top-left, top-right, bottom-right] in data space.
// Each corner is controlled by exactly one min/max field per axis.
const CORNER_DEFS = [
  { xField: "min", yField: "min" }, // 0
  { xField: "min", yField: "max" }, // 1
  { xField: "max", yField: "max" }, // 2
  { xField: "max", yField: "min" }, // 3
];

// Edge order matches the corner pairs they sit between: 0-1 left, 1-2 top,
// 2-3 right, 3-0 bottom. Each edge resizes exactly one coordinate.
const EDGE_DEFS = [
  { field: "min", axis: 0, oppositeField: "max" }, // left: adjusts min.x
  { field: "max", axis: 1, oppositeField: "min" }, // top: adjusts max.y
  { field: "max", axis: 0, oppositeField: "min" }, // right: adjusts max.x
  { field: "min", axis: 1, oppositeField: "max" }, // bottom: adjusts min.y
];

// Local dev (npm run floorplan) has a real server with GET/POST /api/floorplan.
// Anywhere else (e.g. GitHub Pages) is static-only -- saves go straight to
// Supabase instead, using a public row per apartment keyed by apartment_id.
const IS_LOCAL = location.hostname === "localhost" || location.hostname === "127.0.0.1";

const SUPABASE_URL = "https://gkfgypoqicqbjfmcnpxk.supabase.co";
const SUPABASE_KEY = "sb_publishable_PJG8viNrEpnPCr1TMpuhNA_6L6Kx4Nq";
const SUPABASE_TABLE = "floorplan_state";
const supabaseClient = IS_LOCAL ? null : window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// Each apartment has its own floor plan, selected via ?apartment=<id>. A brand
// new apartment has no saved floor plan yet, so loadFloorplanData() falls back
// to this single starter room instead of failing.
const APARTMENT_ID = new URLSearchParams(location.search).get("apartment");
const DEFAULT_FLOORPLAN_DATA = { rooms: [{ id: "room_1", name: "New Room", min: [0, 0], max: [5, 5] }] };

if (!APARTMENT_ID) {
  location.href = "../apartments/apartments.html";
}

const svg = document.getElementById("floorplan-svg");
const canvasWrap = document.getElementById("canvas-wrap");
const editToggle = document.getElementById("edit-toggle");
const cleanupButton = document.getElementById("cleanup-layout");
const addRoomButton = document.getElementById("add-room");
const deleteRoomButton = document.getElementById("delete-room");
const deleteButton = document.getElementById("delete-apartment");
const titleEl = document.getElementById("apartment-title");
const statusEl = document.getElementById("status");

let floorplanData = null;
let transform = null;
let editing = false;
let dragState = null;
let statusClearTimer = null;
let selectedRoomIndex = null;
let elements = { roomPolys: [], roomLabels: [], cornerHandles: [], edgeHandles: [] };

function roomWidth(room) {
  return room.max[0] - room.min[0];
}

function roomHeight(room) {
  return room.max[1] - room.min[1];
}

function roomArea(room) {
  return roomWidth(room) * roomHeight(room);
}

function roomCenter(room) {
  return [(room.min[0] + room.max[0]) / 2, (room.min[1] + room.max[1]) / 2];
}

function cornerPoint(room, i) {
  const def = CORNER_DEFS[i];
  return [room[def.xField][0], room[def.yField][1]];
}

function edgeMidPoint(room, edgeIndex) {
  const def = EDGE_DEFS[edgeIndex];
  const cx = (room.min[0] + room.max[0]) / 2;
  const cy = (room.min[1] + room.max[1]) / 2;
  if (def.axis === 0) {
    return [room[def.field][0], cy];
  }
  return [cx, room[def.field][1]];
}

function computeTransform(rooms) {
  const allPoints = rooms.flatMap((room) => [0, 1, 2, 3].map((i) => cornerPoint(room, i)));
  const xs = allPoints.map((p) => p[0]);
  const ys = allPoints.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return {
    minX,
    maxX,
    minY,
    maxY,
    width: (maxX - minX) * SCALE + MARGIN * 2,
    height: (maxY - minY) * SCALE + MARGIN * 2,
  };
}

function toSvgPoint([x, y]) {
  return [(x - transform.minX) * SCALE + MARGIN, (transform.maxY - y) * SCALE + MARGIN];
}

function toDataPoint([sx, sy]) {
  return [(sx - MARGIN) / SCALE + transform.minX, transform.maxY - (sy - MARGIN) / SCALE];
}

function pointsAttr(room) {
  return [0, 1, 2, 3].map((i) => toSvgPoint(cornerPoint(room, i)).join(",")).join(" ");
}

function createSvgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    el.setAttribute(key, value);
  }
  return el;
}

function render() {
  svg.innerHTML = "";
  elements = { roomPolys: [], roomLabels: [], cornerHandles: [], edgeHandles: [] };

  svg.setAttribute("viewBox", `0 0 ${transform.width} ${transform.height}`);
  svg.setAttribute("width", transform.width);
  svg.setAttribute("height", transform.height);

  // CSS width: fit-content on .canvas-wrap is unreliable here (it depends on
  // the SVG's percentage-based max-width, a known fragile combination) --
  // set the card's width explicitly from the plan's real pixel size instead.
  const CANVAS_PADDING = 32; // .canvas-wrap's 16px padding, both sides
  canvasWrap.style.width = `${transform.width + CANVAS_PADDING}px`;

  floorplanData.rooms.forEach((room, roomIndex) => {
    let fillClass = editing ? "room-fill movable" : "room-fill";
    if (editing && roomIndex === selectedRoomIndex) fillClass += " selected";
    const fill = createSvgEl("polygon", {
      class: fillClass,
      points: pointsAttr(room),
      fill: PALETTE[roomIndex % PALETTE.length],
      "data-room-index": roomIndex,
    });
    svg.appendChild(fill);
    elements.roomPolys[roomIndex] = fill;

    const [cx, cy] = toSvgPoint(roomCenter(room));
    const label = createSvgEl("text", {
      class: editing ? "room-label editable" : "room-label",
      x: cx,
      y: cy,
      "data-room-index": roomIndex,
    });
    label.textContent = room.name;
    svg.appendChild(label);
    elements.roomLabels[roomIndex] = label;

    elements.cornerHandles[roomIndex] = [];
    elements.edgeHandles[roomIndex] = [];

    if (editing) {
      for (let i = 0; i < 4; i++) {
        const [hx, hy] = toSvgPoint(cornerPoint(room, i));
        const handle = createSvgEl("circle", {
          class: "corner-handle",
          cx: hx,
          cy: hy,
          r: 6,
          "data-room-index": roomIndex,
          "data-corner-index": i,
        });
        svg.appendChild(handle);
        elements.cornerHandles[roomIndex][i] = handle;
      }

      for (let i = 0; i < 4; i++) {
        const [hx, hy] = toSvgPoint(edgeMidPoint(room, i));
        const handle = createSvgEl("circle", {
          class: "edge-handle",
          cx: hx,
          cy: hy,
          r: 5,
          "data-room-index": roomIndex,
          "data-edge-index": i,
        });
        svg.appendChild(handle);
        elements.edgeHandles[roomIndex][i] = handle;
      }
    }
  });
}

function updateRoomVisual(roomIndex) {
  const room = floorplanData.rooms[roomIndex];

  elements.roomPolys[roomIndex].setAttribute("points", pointsAttr(room));

  const [cx, cy] = toSvgPoint(roomCenter(room));
  elements.roomLabels[roomIndex].setAttribute("x", cx);
  elements.roomLabels[roomIndex].setAttribute("y", cy);

  for (let i = 0; i < 4; i++) {
    const [hx, hy] = toSvgPoint(cornerPoint(room, i));
    const handle = elements.cornerHandles[roomIndex][i];
    if (handle) {
      handle.setAttribute("cx", hx);
      handle.setAttribute("cy", hy);
    }
  }

  for (let i = 0; i < 4; i++) {
    const [hx, hy] = toSvgPoint(edgeMidPoint(room, i));
    const handle = elements.edgeHandles[roomIndex][i];
    if (handle) {
      handle.setAttribute("cx", hx);
      handle.setAttribute("cy", hy);
    }
  }
}

function setStatus(kind, message) {
  clearTimeout(statusClearTimer);
  statusEl.classList.remove("saving", "saved", "error");

  if (kind === "saving") {
    statusEl.textContent = "Saving…";
    statusEl.classList.add("saving");
  } else if (kind === "saved") {
    statusEl.textContent = "Saved";
    statusEl.classList.add("saved");
    statusClearTimer = setTimeout(() => {
      statusEl.textContent = "";
    }, 2000);
  } else if (kind === "error") {
    statusEl.textContent = message || "Save failed";
    statusEl.classList.add("error");
  } else {
    statusEl.textContent = "";
  }
}

// Saves happen on pointerup, on rename, and from "Clean up layout" -- these
// can fire in close succession. Chain them so a save's request always goes
// out after the previous one has finished, keeping writes in the order the
// user triggered them instead of letting network completion order decide.
let supabaseSaveChain = Promise.resolve();

function saveViaSupabase() {
  setStatus("saving");

  supabaseSaveChain = supabaseSaveChain
    .then(() =>
      supabaseClient
        .from(SUPABASE_TABLE)
        .upsert(
          { apartment_id: APARTMENT_ID, data: floorplanData, updated_at: new Date().toISOString() },
          { onConflict: "apartment_id" }
        )
    )
    .then(({ error }) => {
      if (error) throw error;
      setStatus("saved");
    })
    .catch((err) => {
      console.error("Failed to save floor plan via Supabase:", err);
      setStatus("error", "Save failed");
    });
}

function saveFloorplan() {
  if (!IS_LOCAL) {
    saveViaSupabase();
    return;
  }

  setStatus("saving");
  fetch(`/api/floorplan?apartment=${encodeURIComponent(APARTMENT_ID)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(floorplanData),
  })
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then(() => setStatus("saved"))
    .catch((err) => {
      console.error("Failed to save floor plan:", err);
      setStatus("error");
    });
}

function clampCoord(value, fixed, isMin) {
  return isMin ? Math.min(value, fixed - MIN_ROOM_DIM_M) : Math.max(value, fixed + MIN_ROOM_DIM_M);
}

function applyCornerDrag(room, cornerIndex, dataPoint) {
  const def = CORNER_DEFS[cornerIndex];
  const oppositeX = def.xField === "min" ? room.max[0] : room.min[0];
  const oppositeY = def.yField === "min" ? room.max[1] : room.min[1];
  room[def.xField][0] = clampCoord(dataPoint[0], oppositeX, def.xField === "min");
  room[def.yField][1] = clampCoord(dataPoint[1], oppositeY, def.yField === "min");
}

function applyEdgeDrag(room, edgeIndex, dataPoint) {
  const def = EDGE_DEFS[edgeIndex];
  const value = def.axis === 0 ? dataPoint[0] : dataPoint[1];
  const fixed = room[def.oppositeField][def.axis];
  room[def.field][def.axis] = clampCoord(value, fixed, def.field === "min");
}

function startCornerDrag(roomIndex, cornerIndex, pointerId) {
  dragState = { type: "corner", roomIndex, index: cornerIndex, pointerId };
}

function startEdgeDrag(roomIndex, edgeIndex, pointerId) {
  dragState = { type: "edge", roomIndex, index: edgeIndex, pointerId };
}

function startTranslateDrag(roomIndex, pointerId, startDataPoint) {
  const room = floorplanData.rooms[roomIndex];
  dragState = {
    type: "translate",
    roomIndex,
    pointerId,
    startDataPoint,
    origMin: [room.min[0], room.min[1]],
    origMax: [room.max[0], room.max[1]],
  };
}

function applyDrag(dataPoint) {
  const room = floorplanData.rooms[dragState.roomIndex];

  if (dragState.type === "corner") {
    applyCornerDrag(room, dragState.index, dataPoint);
  } else if (dragState.type === "edge") {
    applyEdgeDrag(room, dragState.index, dataPoint);
  } else if (dragState.type === "translate") {
    const dx = dataPoint[0] - dragState.startDataPoint[0];
    const dy = dataPoint[1] - dragState.startDataPoint[1];
    room.min = [dragState.origMin[0] + dx, dragState.origMin[1] + dy];
    room.max = [dragState.origMax[0] + dx, dragState.origMax[1] + dy];
  }

  updateRoomVisual(dragState.roomIndex);
}

function startRename(roomIndex, labelEl) {
  const room = floorplanData.rooms[roomIndex];
  const svgRect = svg.getBoundingClientRect();
  const wrapRect = canvasWrap.getBoundingClientRect();
  const scaleX = svgRect.width / transform.width;
  const scaleY = svgRect.height / transform.height;
  const bbox = labelEl.getBBox();

  const screenX = svgRect.left - wrapRect.left + canvasWrap.scrollLeft + bbox.x * scaleX;
  const screenY = svgRect.top - wrapRect.top + canvasWrap.scrollTop + bbox.y * scaleY;
  const screenW = Math.max(bbox.width * scaleX, 60);

  const input = document.createElement("input");
  input.type = "text";
  input.className = "rename-input";
  input.value = room.name;
  input.style.left = `${screenX - 10}px`;
  input.style.top = `${screenY - 3}px`;
  input.style.width = `${screenW + 20}px`;
  canvasWrap.appendChild(input);
  input.focus();
  input.select();

  let done = false;
  function commit() {
    if (done) return;
    done = true;
    const newName = input.value.trim();
    if (newName) {
      room.name = newName;
      elements.roomLabels[roomIndex].textContent = newName;
    }
    cleanup();
    saveFloorplan();
  }
  function cancel() {
    if (done) return;
    done = true;
    cleanup();
  }
  function cleanup() {
    input.removeEventListener("blur", commit);
    input.removeEventListener("keydown", onKeydown);
    input.remove();
  }
  function onKeydown(event) {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  }
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", onKeydown);
}

// ---- Clean up layout: auto-rotate to vertical, then snap adjacent edges ----
// Manual, on-demand only -- never runs automatically.

function normalizeAngle(angle) {
  while (angle > Math.PI / 2) angle -= Math.PI;
  while (angle <= -Math.PI / 2) angle += Math.PI;
  return angle;
}

function rotatePoint([x, y], [cx, cy], angle) {
  const dx = x - cx;
  const dy = y - cy;
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);
  return [cx + dx * cosA - dy * sinA, cy + dx * sinA + dy * cosA];
}

function autoRotateToVertical(rooms) {
  if (rooms.length === 0) return;

  let largest = rooms[0];
  for (const room of rooms) {
    if (roomArea(room) > roomArea(largest)) largest = room;
  }

  // Rooms are always axis-aligned, so the long edge direction is trivially
  // horizontal or vertical -- this rotation is at most +/-90 degrees, e.g.
  // "flip the whole layout from landscape to portrait."
  const direction = roomWidth(largest) >= roomHeight(largest) ? [1, 0] : [0, 1];
  const edgeAngle = Math.atan2(direction[1], direction[0]);
  const rotation = normalizeAngle(Math.PI / 2 - edgeAngle);
  if (Math.abs(rotation) < 1e-9) return;

  const centroid = [
    rooms.reduce((sum, r) => sum + roomCenter(r)[0], 0) / rooms.length,
    rooms.reduce((sum, r) => sum + roomCenter(r)[1], 0) / rooms.length,
  ];

  for (const room of rooms) {
    const corners = [0, 1, 2, 3].map((i) => rotatePoint(cornerPoint(room, i), centroid, rotation));
    const xs = corners.map((p) => p[0]);
    const ys = corners.map((p) => p[1]);
    room.min = [Math.min(...xs), Math.min(...ys)];
    room.max = [Math.max(...xs), Math.max(...ys)];
  }
}

function rangesOverlap(aMin, aMax, bMin, bMax, tolerance) {
  return aMin <= bMax + tolerance && bMin <= aMax + tolerance;
}

function clusterAndSnap(edges, tolerance, shouldLink) {
  const n = edges.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(i) {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  }
  function union(i, j) {
    const ri = find(i);
    const rj = find(j);
    if (ri !== rj) parent[ri] = rj;
  }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (edges[i].room === edges[j].room) continue;
      if (Math.abs(edges[i].value - edges[j].value) <= tolerance && shouldLink(edges[i], edges[j])) {
        union(i, j);
      }
    }
  }

  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(edges[i]);
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const avg = group.reduce((sum, e) => sum + e.value, 0) / group.length;
    for (const e of group) {
      e.room[e.field][e.axis] = avg;
    }
  }
}

function snapAdjacentEdges(rooms, tolerance) {
  const vEdges = rooms.flatMap((room) => [
    { room, field: "min", axis: 0, value: room.min[0] },
    { room, field: "max", axis: 0, value: room.max[0] },
  ]);
  clusterAndSnap(vEdges, tolerance, (a, b) =>
    rangesOverlap(a.room.min[1], a.room.max[1], b.room.min[1], b.room.max[1], tolerance)
  );

  const hEdges = rooms.flatMap((room) => [
    { room, field: "min", axis: 1, value: room.min[1] },
    { room, field: "max", axis: 1, value: room.max[1] },
  ]);
  clusterAndSnap(hEdges, tolerance, (a, b) =>
    rangesOverlap(a.room.min[0], a.room.max[0], b.room.min[0], b.room.max[0], tolerance)
  );
}

function cleanUpLayout() {
  if (!floorplanData || floorplanData.rooms.length === 0) return;

  autoRotateToVertical(floorplanData.rooms);
  snapAdjacentEdges(floorplanData.rooms, SNAP_TOLERANCE_M);

  transform = computeTransform(floorplanData.rooms);
  render();
  saveFloorplan();
}

// ---- Room selection & add/delete ----

function applySelectionVisual() {
  elements.roomPolys.forEach((poly, i) => {
    if (poly) poly.classList.toggle("selected", i === selectedRoomIndex);
  });
}

function updateToolButtonsState() {
  addRoomButton.disabled = !editing;
  deleteRoomButton.disabled = !editing || selectedRoomIndex === null;
}

function selectRoom(roomIndex) {
  selectedRoomIndex = roomIndex;
  applySelectionVisual();
  updateToolButtonsState();
}

function deselectRoom() {
  if (selectedRoomIndex === null) return;
  selectedRoomIndex = null;
  applySelectionVisual();
  updateToolButtonsState();
}

function addRoom() {
  if (!editing || !floorplanData) return;

  const existingIds = new Set(floorplanData.rooms.map((r) => r.id));
  let n = floorplanData.rooms.length + 1;
  while (existingIds.has(`room_${n}`)) n++;

  const SIZE = 3; // meters, new room is a plain square
  let minX = 0;
  let minY = 0;
  if (floorplanData.rooms.length > 0) {
    minX = Math.max(...floorplanData.rooms.map((r) => r.max[0])) + 1;
    minY = Math.min(...floorplanData.rooms.map((r) => r.min[1]));
  }

  floorplanData.rooms.push({
    id: `room_${n}`,
    name: `Room ${n}`,
    min: [minX, minY],
    max: [minX + SIZE, minY + SIZE],
  });

  selectedRoomIndex = floorplanData.rooms.length - 1;
  transform = computeTransform(floorplanData.rooms);
  render();
  updateToolButtonsState();
  saveFloorplan();
}

function deleteRoom() {
  if (selectedRoomIndex === null || !floorplanData) return;
  if (!confirm("Delete this room?")) return;

  floorplanData.rooms.splice(selectedRoomIndex, 1);
  selectedRoomIndex = null;

  if (floorplanData.rooms.length === 0) {
    floorplanData.rooms.push({ id: "room_1", name: "New Room", min: [0, 0], max: [5, 5] });
  }

  transform = computeTransform(floorplanData.rooms);
  render();
  updateToolButtonsState();
  saveFloorplan();
}

// ---- Event wiring ----

svg.addEventListener("pointerdown", (event) => {
  if (!editing) return;
  const target = event.target;
  if (!target.classList) return;

  if (target.classList.contains("corner-handle")) {
    event.preventDefault();
    const roomIndex = Number(target.getAttribute("data-room-index"));
    const cornerIndex = Number(target.getAttribute("data-corner-index"));
    startCornerDrag(roomIndex, cornerIndex, event.pointerId);
    target.classList.add("dragging");
    svg.setPointerCapture(event.pointerId);
  } else if (target.classList.contains("edge-handle")) {
    event.preventDefault();
    const roomIndex = Number(target.getAttribute("data-room-index"));
    const edgeIndex = Number(target.getAttribute("data-edge-index"));
    startEdgeDrag(roomIndex, edgeIndex, event.pointerId);
    target.classList.add("dragging");
    svg.setPointerCapture(event.pointerId);
  } else if (target.classList.contains("room-label")) {
    event.preventDefault();
    const roomIndex = Number(target.getAttribute("data-room-index"));
    startRename(roomIndex, target);
  } else if (target.classList.contains("room-fill")) {
    event.preventDefault();
    const roomIndex = Number(target.getAttribute("data-room-index"));
    selectRoom(roomIndex);
    const svgRect = svg.getBoundingClientRect();
    const scaleX = transform.width / svgRect.width;
    const scaleY = transform.height / svgRect.height;
    const sx = (event.clientX - svgRect.left) * scaleX;
    const sy = (event.clientY - svgRect.top) * scaleY;
    startTranslateDrag(roomIndex, event.pointerId, toDataPoint([sx, sy]));
    target.classList.add("dragging");
    svg.setPointerCapture(event.pointerId);
  } else if (target === svg) {
    deselectRoom();
  }
});

window.addEventListener("pointermove", (event) => {
  if (!dragState || event.pointerId !== dragState.pointerId) return;

  const svgRect = svg.getBoundingClientRect();
  const scaleX = transform.width / svgRect.width;
  const scaleY = transform.height / svgRect.height;
  const sx = (event.clientX - svgRect.left) * scaleX;
  const sy = (event.clientY - svgRect.top) * scaleY;

  applyDrag(toDataPoint([sx, sy]));
});

window.addEventListener("pointerup", (event) => {
  if (!dragState || event.pointerId !== dragState.pointerId) return;

  let handle = null;
  if (dragState.type === "corner") {
    handle = elements.cornerHandles[dragState.roomIndex][dragState.index];
  } else if (dragState.type === "edge") {
    handle = elements.edgeHandles[dragState.roomIndex][dragState.index];
  } else if (dragState.type === "translate") {
    handle = elements.roomPolys[dragState.roomIndex];
  }
  if (handle) handle.classList.remove("dragging");
  if (svg.hasPointerCapture(event.pointerId)) {
    svg.releasePointerCapture(event.pointerId);
  }

  dragState = null;
  saveFloorplan();
});

editToggle.addEventListener("click", () => {
  editing = !editing;
  editToggle.textContent = editing ? "Disable editing" : "Enable editing";
  editToggle.classList.toggle("active", editing);
  if (!editing) selectedRoomIndex = null;
  render();
  updateToolButtonsState();
});

cleanupButton.addEventListener("click", cleanUpLayout);
addRoomButton.addEventListener("click", addRoom);
deleteRoomButton.addEventListener("click", deleteRoom);

function loadFloorplanData() {
  if (IS_LOCAL) {
    return fetch(`/api/floorplan?apartment=${encodeURIComponent(APARTMENT_ID)}`).then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    });
  }
  return supabaseClient
    .from(SUPABASE_TABLE)
    .select("data")
    .eq("apartment_id", APARTMENT_ID)
    .maybeSingle()
    .then(({ data, error }) => {
      if (error) throw error;
      return data ? data.data : DEFAULT_FLOORPLAN_DATA;
    });
}

function deleteFloorplanData() {
  if (IS_LOCAL) {
    return fetch(`/api/floorplan?apartment=${encodeURIComponent(APARTMENT_ID)}`, { method: "DELETE" });
  }
  // The query builder is thenable but doesn't implement .catch() itself --
  // .then() here turns it into a real Promise so the caller's .catch() works.
  return supabaseClient
    .from(SUPABASE_TABLE)
    .delete()
    .eq("apartment_id", APARTMENT_ID)
    .then(({ error }) => {
      if (error) throw error;
    });
}

function deleteApartment() {
  if (!confirm("Delete this apartment? This can't be undone.")) return;

  deleteButton.disabled = true;
  deleteButton.textContent = "Deleting…";

  loadApartments()
    .then((data) => {
      const remaining = (data.apartments || []).filter((a) => a.id !== APARTMENT_ID);
      return saveApartments(remaining);
    })
    .then(() =>
      deleteFloorplanData().catch((err) => {
        // Apartment record is already gone -- an orphaned floor plan row/entry
        // is harmless, so log and continue rather than blocking navigation.
        console.error("Failed to clean up floor plan data:", err);
      })
    )
    .then(() => {
      window.location.href = "../apartments/apartments.html";
    })
    .catch((err) => {
      console.error("Failed to delete apartment:", err);
      deleteButton.disabled = false;
      deleteButton.textContent = "Delete apartment";
      setStatus("error", "Delete failed");
    });
}

deleteButton.addEventListener("click", deleteApartment);

loadApartments()
  .then((data) => {
    const apartment = (data.apartments || []).find((a) => a.id === APARTMENT_ID);
    if (!apartment) {
      window.location.href = "../apartments/apartments.html";
      return;
    }
    titleEl.textContent = apartment.name;
    document.title = `${apartment.name} — Floor Plan`;
  })
  .catch((err) => {
    console.error("Failed to load apartment info:", err);
  });

loadFloorplanData()
  .then((data) => {
    floorplanData = data;
    transform = computeTransform(data.rooms);
    render();
  })
  .catch((err) => {
    console.error("Failed to load floor plan data:", err);
    statusEl.textContent = "Failed to load floor plan";
    statusEl.classList.add("error");
  });
