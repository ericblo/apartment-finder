const SVG_NS = "http://www.w3.org/2000/svg";
const SCALE = 40; // px per meter
const MARGIN = 60; // px padding around the plan
const MIN_ROOM_DIM_M = 0.1;

const PALETTE = ["#f6c7a3", "#b7dd9a", "#f3b6d3", "#a9d1f0", "#e0c26f", "#c9b6f0"];

// Corner order: [bottom-left, top-left, top-right, bottom-right] in the room's own
// (possibly rotated) local frame, where "width" runs along u and "height" along v.
const CORNER_SIGNS = [
  [-1, -1],
  [-1, 1],
  [1, 1],
  [1, -1],
];

// Edge midpoints, in the same local frame. Each edge resizes exactly one dimension.
const EDGE_DEFS = [
  { varies: "width", su: -1, sv: 0 }, // left
  { varies: "height", su: 0, sv: 1 }, // top
  { varies: "width", su: 1, sv: 0 }, // right
  { varies: "height", su: 0, sv: -1 }, // bottom
];

const svg = document.getElementById("floorplan-svg");
const canvasWrap = document.getElementById("canvas-wrap");
const editToggle = document.getElementById("edit-toggle");
const statusEl = document.getElementById("status");

let floorplanData = null;
let transform = null;
let editing = false;
let dragState = null;
let statusClearTimer = null;
let elements = { roomPolys: [], roomLabels: [], cornerHandles: [], edgeHandles: [] };

function degToRad(deg) {
  return (deg * Math.PI) / 180;
}

function roomAxes(room) {
  const r = degToRad(room.angle_deg);
  return { u: [Math.cos(r), Math.sin(r)], v: [-Math.sin(r), Math.cos(r)] };
}

function cornerPoint(room, i) {
  const { u, v } = roomAxes(room);
  const [su, sv] = CORNER_SIGNS[i];
  const hw = room.width / 2;
  const hh = room.height / 2;
  return [room.center[0] + su * hw * u[0] + sv * hh * v[0], room.center[1] + su * hw * u[1] + sv * hh * v[1]];
}

function edgeMidPoint(room, edgeIndex) {
  const { u, v } = roomAxes(room);
  const def = EDGE_DEFS[edgeIndex];
  const hw = room.width / 2;
  const hh = room.height / 2;
  return [room.center[0] + def.su * hw * u[0] + def.sv * hh * v[0], room.center[1] + def.su * hw * u[1] + def.sv * hh * v[1]];
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

  floorplanData.rooms.forEach((room, roomIndex) => {
    const fill = createSvgEl("polygon", {
      class: "room-fill",
      points: pointsAttr(room),
      fill: PALETTE[roomIndex % PALETTE.length],
    });
    svg.appendChild(fill);
    elements.roomPolys[roomIndex] = fill;

    const [cx, cy] = toSvgPoint(room.center);
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

  const [cx, cy] = toSvgPoint(room.center);
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

function finalizeRoomGeometry(room) {
  room.corners = [0, 1, 2, 3].map((i) => cornerPoint(room, i));
  room.area_m2 = Math.round(room.width * room.height * 1000) / 1000;
}

function setStatus(kind) {
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
    statusEl.textContent = "Save failed";
    statusEl.classList.add("error");
  } else {
    statusEl.textContent = "";
  }
}

function saveFloorplan() {
  setStatus("saving");
  fetch("/api/floorplan", {
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

function startCornerDrag(roomIndex, cornerIndex, pointerId) {
  const room = floorplanData.rooms[roomIndex];
  const fixedIndex = (cornerIndex + 2) % 4;
  dragState = {
    type: "corner",
    roomIndex,
    index: cornerIndex,
    fixedPoint: cornerPoint(room, fixedIndex),
    axes: roomAxes(room),
    pointerId,
  };
}

function startEdgeDrag(roomIndex, edgeIndex, pointerId) {
  const room = floorplanData.rooms[roomIndex];
  const fixedIndex = (edgeIndex + 2) % 4;
  dragState = {
    type: "edge",
    roomIndex,
    index: edgeIndex,
    varies: EDGE_DEFS[edgeIndex].varies,
    fixedPoint: edgeMidPoint(room, fixedIndex),
    axes: roomAxes(room),
    pointerId,
  };
}

function applyDrag(dataPoint) {
  const room = floorplanData.rooms[dragState.roomIndex];
  const { u, v } = dragState.axes;
  const fp = dragState.fixedPoint;
  const d = [dataPoint[0] - fp[0], dataPoint[1] - fp[1]];
  const alongU = d[0] * u[0] + d[1] * u[1];
  const alongV = d[0] * v[0] + d[1] * v[1];

  if (dragState.type === "corner") {
    room.width = Math.max(MIN_ROOM_DIM_M, Math.abs(alongU));
    room.height = Math.max(MIN_ROOM_DIM_M, Math.abs(alongV));
    room.center = [(fp[0] + dataPoint[0]) / 2, (fp[1] + dataPoint[1]) / 2];
  } else if (dragState.varies === "width") {
    room.width = Math.max(MIN_ROOM_DIM_M, Math.abs(alongU));
    room.center = [fp[0] + (alongU / 2) * u[0], fp[1] + (alongU / 2) * u[1]];
  } else {
    room.height = Math.max(MIN_ROOM_DIM_M, Math.abs(alongV));
    room.center = [fp[0] + (alongV / 2) * v[0], fp[1] + (alongV / 2) * v[1]];
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

  const room = floorplanData.rooms[dragState.roomIndex];
  finalizeRoomGeometry(room);

  const handleList = dragState.type === "corner" ? elements.cornerHandles : elements.edgeHandles;
  const handle = handleList[dragState.roomIndex][dragState.index];
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
  render();
});

fetch("/api/floorplan")
  .then((res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  })
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
