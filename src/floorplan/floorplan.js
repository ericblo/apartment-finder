const SVG_NS = "http://www.w3.org/2000/svg";
const SCALE = 40; // px per meter
const MARGIN = 40; // px padding around the plan

const ROOM_COLORS = {
  room_1: "#f6c7a3",
  room_3: "#b7dd9a",
  room_4: "#f3b6d3",
};
const DEFAULT_PALETTE = ["#a9d1f0", "#e0c26f", "#c9b6f0", "#f0b6b6"];

const svg = document.getElementById("floorplan-svg");
const editToggle = document.getElementById("edit-toggle");
const statusEl = document.getElementById("status");

let floorplanData = null;
let transform = null;
let editing = false;
let dragState = null; // { roomIndex, vertexIndex, pointerId }
let statusClearTimer = null;
let elements = { roomPolys: [], roomLabels: [], vertexHandles: [] };

function computeTransform(data) {
  const allPoints = [...data.building_outline, ...data.rooms.flatMap((r) => r.polygon)];
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

function pointsAttr(polygon) {
  return polygon.map((p) => toSvgPoint(p).join(",")).join(" ");
}

function polygonCentroid(polygon) {
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < polygon.length; i++) {
    const [x0, y0] = polygon[i];
    const [x1, y1] = polygon[(i + 1) % polygon.length];
    const cross = x0 * y1 - x1 * y0;
    area += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  area *= 0.5;
  if (Math.abs(area) < 1e-9) {
    const n = polygon.length;
    const sum = polygon.reduce((acc, [x, y]) => [acc[0] + x, acc[1] + y], [0, 0]);
    return [sum[0] / n, sum[1] / n];
  }
  return [cx / (6 * area), cy / (6 * area)];
}

function roomColor(room, index) {
  return ROOM_COLORS[room.id] || DEFAULT_PALETTE[index % DEFAULT_PALETTE.length];
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
  elements = { roomPolys: [], roomLabels: [], vertexHandles: [] };

  svg.setAttribute("viewBox", `0 0 ${transform.width} ${transform.height}`);
  svg.setAttribute("width", transform.width);
  svg.setAttribute("height", transform.height);

  const outline = createSvgEl("polygon", {
    class: "building-outline",
    points: pointsAttr(floorplanData.building_outline),
  });
  svg.appendChild(outline);

  floorplanData.rooms.forEach((room, roomIndex) => {
    const fill = createSvgEl("polygon", {
      class: "room-fill",
      points: pointsAttr(room.polygon),
      fill: roomColor(room, roomIndex),
    });
    svg.appendChild(fill);
    elements.roomPolys[roomIndex] = fill;

    const [cx, cy] = toSvgPoint(polygonCentroid(room.polygon));
    const label = createSvgEl("text", { class: "room-label", x: cx, y: cy });
    label.textContent = room.name;
    svg.appendChild(label);
    elements.roomLabels[roomIndex] = label;

    elements.vertexHandles[roomIndex] = [];
    if (editing) {
      room.polygon.forEach((vertex, vertexIndex) => {
        const [vx, vy] = toSvgPoint(vertex);
        const handle = createSvgEl("circle", {
          class: "vertex-handle",
          cx: vx,
          cy: vy,
          r: 6,
          "data-room-index": roomIndex,
          "data-vertex-index": vertexIndex,
        });
        svg.appendChild(handle);
        elements.vertexHandles[roomIndex][vertexIndex] = handle;
      });
    }
  });
}

function updateVertexVisual(roomIndex, vertexIndex) {
  const room = floorplanData.rooms[roomIndex];

  elements.roomPolys[roomIndex].setAttribute("points", pointsAttr(room.polygon));

  const [cx, cy] = toSvgPoint(polygonCentroid(room.polygon));
  elements.roomLabels[roomIndex].setAttribute("x", cx);
  elements.roomLabels[roomIndex].setAttribute("y", cy);

  const handle = elements.vertexHandles[roomIndex][vertexIndex];
  if (handle) {
    const [vx, vy] = toSvgPoint(room.polygon[vertexIndex]);
    handle.setAttribute("cx", vx);
    handle.setAttribute("cy", vy);
  }
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

svg.addEventListener("pointerdown", (event) => {
  if (!editing) return;
  const target = event.target;
  if (!target.classList || !target.classList.contains("vertex-handle")) return;

  event.preventDefault();
  const roomIndex = Number(target.getAttribute("data-room-index"));
  const vertexIndex = Number(target.getAttribute("data-vertex-index"));
  dragState = { roomIndex, vertexIndex, pointerId: event.pointerId };
  target.classList.add("dragging");
  svg.setPointerCapture(event.pointerId);
});

window.addEventListener("pointermove", (event) => {
  if (!dragState || event.pointerId !== dragState.pointerId) return;

  const svgRect = svg.getBoundingClientRect();
  const scaleX = transform.width / svgRect.width;
  const scaleY = transform.height / svgRect.height;
  const sx = (event.clientX - svgRect.left) * scaleX;
  const sy = (event.clientY - svgRect.top) * scaleY;

  const room = floorplanData.rooms[dragState.roomIndex];
  room.polygon[dragState.vertexIndex] = toDataPoint([sx, sy]);
  updateVertexVisual(dragState.roomIndex, dragState.vertexIndex);
});

window.addEventListener("pointerup", (event) => {
  if (!dragState || event.pointerId !== dragState.pointerId) return;

  const handle = elements.vertexHandles[dragState.roomIndex][dragState.vertexIndex];
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
    transform = computeTransform(data);
    render();
  })
  .catch((err) => {
    console.error("Failed to load floor plan data:", err);
    statusEl.textContent = "Failed to load floor plan";
    statusEl.classList.add("error");
  });
